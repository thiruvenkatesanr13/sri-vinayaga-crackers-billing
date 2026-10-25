"""Product and stock import from the shop's stock sheet (Excel).

The sheet (Cracker_Inventory_new.xlsx) has a header row, then products in groups, each
group under a category name on its own row:

    Sparkle | QTY Removed | Qty Add | How many cases for a bundle | Final Price

Qty Add and QTY Removed are this time's amounts: Qty Add is added to the stock and QTY
Removed is taken off (300 in stock, Qty Add 50 -> 350; QTY Removed 50 -> 250). The sheet
keeps last time's numbers, so an amount that is the same as at the item's last import is
not used again unless the import is told to (the "Again" tick); importing the same sheet
twice changes nothing. "How many cases for a bundle" is how many pieces make one bundle
("Nil" when not sold as a bundle). Price and bundle size are taken from the sheet when they
change there, so a change made in the app stays until the sheet changes it.

The older layout (name, Qty, Final Price) still works: Qty counts as Qty Add.
Columns are found by their header names, so their order does not matter.
"""

import hashlib
import io
import re
from collections import Counter as Tally
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

import openpyxl
from django.conf import settings
from django.db import transaction

from core.audit import audit
from core.errors import BusinessError
from inventory.models import Location, StockMovement
from inventory.services import change_stock

from .models import Category, ImportBatch, Product

DEFAULT_CATEGORIES = [
    ("Sparklers", "SP"),
    ("Flower Pots", "FP"),
    ("Ground Chakkars", "GC"),
    ("Crackers", "CR"),
    ("Shots", "SH"),
    ("Wala", "WL"),
    ("Gun", "GN"),
    ("Fancy Items", "FY"),
    ("Gift Boxes", "GB"),
]

HEADINGS = {
    "sparkle": "Sparklers",
    "sparkles": "Sparklers",
    "sparklers": "Sparklers",
    "flower pot": "Flower Pots",
    "flower pots": "Flower Pots",
    "ground chakkara": "Ground Chakkars",
    "ground chakkar": "Ground Chakkars",
    "ground chakkars": "Ground Chakkars",
    "crackers": "Crackers",
    "shots": "Shots",
    "wala": "Wala",
    "gun": "Gun",
    "guns": "Gun",
    "fancy items": "Fancy Items",
    "fancy": "Fancy Items",
    "gift boxes": "Gift Boxes",
    "gift box": "Gift Boxes",
}

FLAG_TEXT = {
    "category_guess": "No category heading above this item - check its category.",
    "maybe_cut": "Name is exactly 20 letters long - it may be cut short.",
    "odd_end": "Name ends oddly - it may be incomplete.",
    "duplicate": "The same name appears more than once in the sheet. Only the first is used.",
    "no_stock": "Gift box packed at sale: its stock comes from the items inside, so its own quantities are not used.",
}

NIL = {"", "nil", "-", "na", "n/a", "no", "none", "0"}
MAX_FILE_BYTES = 2 * 1024 * 1024
_SHA = re.compile(r"^[0-9a-f]{64}$")


def ensure_default_categories() -> None:
    for order, (name, code) in enumerate(DEFAULT_CATEGORIES):
        Category.objects.get_or_create(name=name, defaults={"code": code, "sort_order": order})


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        try:
            return Decimal(value.replace(",", "").strip())
        except InvalidOperation:
            return None
    return None


def _tidy(text) -> str:
    return re.sub(r"\s+", " ", str(text)).strip() if text is not None else ""


def category_for_heading(text: str) -> str:
    return HEADINGS.get(_tidy(text).lower(), _tidy(text).title())


def _columns(cells: list) -> dict | None:
    """Where each column is, read from a header row. None when the row is not a header."""
    found: dict[str, int] = {}
    for index, value in enumerate(cells[1:], start=1):
        text = _tidy(value).lower()
        if not text or _number(value) is not None:
            continue
        if "remov" in text:
            found.setdefault("removed", index)
        elif "bundle" in text or "case" in text:
            found.setdefault("bundle", index)
        elif "price" in text or "rate" in text:
            found.setdefault("price", index)
        elif "add" in text or text in ("qty", "quantity", "stock"):
            found.setdefault("added", index)
    return found if "added" in found and "price" in found else None


def _whole(raw, label: str, errors: list) -> int:
    """A count from the sheet: blank means 0."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return 0
    value = _number(raw)
    if value is None or value < 0 or value != value.to_integral_value():
        errors.append(f"{label} must be a whole number")
        return 0
    return int(value)


def _bundle(raw, errors: list) -> int | None:
    if raw is None or _tidy(raw).lower() in NIL:
        return None
    value = _number(raw)
    if value is None or value != value.to_integral_value() or value < 2:
        errors.append("Bundle must be 2 or more, or Nil")
        return None
    return int(value)


def parse_workbook(data: bytes) -> tuple[list[dict], str]:
    """The sheet's product rows, and its layout: "sheet" (with QTY Removed and bundle) or "simple"."""
    try:
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception:
        raise BusinessError("This file could not be read. Save it as an Excel (.xlsx) file and try again.", code="bad_file")

    rows: list[dict] = []
    try:
        sheet = workbook.worksheets[0]
        columns = None
        current = None
        since_heading = 0
        gap = False
        guessing = False
        for row_no, values in enumerate(sheet.iter_rows(min_row=1, max_col=12, values_only=True), start=1):
            cells = list(values) + [None] * 12
            if columns is None and row_no <= 5:
                found = _columns(cells)
                if found:
                    columns = found
                    if _tidy(cells[0]).lower() in HEADINGS:
                        # The first header cell ("Sparkle") also names the first group.
                        current, since_heading = category_for_heading(cells[0]), 0
                    continue
            layout = columns or {"added": 1, "price": 2}
            name = _tidy(cells[0])
            raw = {key: cells[index] for key, index in layout.items()}
            numbers_blank = all(v is None or (isinstance(v, str) and not v.strip()) for v in raw.values())
            if not name and numbers_blank:
                if since_heading:
                    gap = True
                continue
            if name and numbers_blank:
                current, since_heading, gap, guessing = category_for_heading(name), 0, False, False
                continue
            if gap:
                guessing, gap = True, False
            flags, errors = [], []
            if guessing:
                flags.append("category_guess")
            if not name:
                errors.append("Name is missing")
            added = _whole(raw.get("added"), "Qty Add", errors)
            removed = _whole(raw.get("removed"), "QTY Removed", errors)
            bundle_given = "bundle" in layout
            bundle = _bundle(raw.get("bundle"), errors) if bundle_given else None
            price = _number(raw.get("price"))
            if price is None or price <= 0:
                errors.append("Price must be more than 0")
            if len(name) == 20:
                flags.append("maybe_cut")
            if name.endswith(("&", "/", "-", ",", "(")) or name.count("(") > name.count(")"):
                flags.append("odd_end")
            rows.append(
                {
                    "row": row_no,
                    "name": name,
                    "category": current or "",
                    "added": added,
                    "removed": removed,
                    "bundle": bundle,
                    "bundle_given": bundle_given,
                    "price_paise": int((price * 100).quantize(Decimal("1"), ROUND_HALF_UP))
                    if price is not None and price > 0
                    else None,
                    "flags": flags,
                    "errors": errors,
                }
            )
            since_heading += 1
    finally:
        workbook.close()

    names = Tally(r["name"].lower() for r in rows if r["name"])
    seen = set()
    for row in rows:
        key = row["name"].lower()
        if key and names[key] > 1:
            row["flags"].append("duplicate")
            if key in seen and not row["errors"]:
                row["errors"].append("Listed again lower down")
            seen.add(key)
    layout = "sheet" if columns and "removed" in columns else "simple"
    return rows, layout


class _Products:
    """Finds the app's item for a sheet row: same name and category, or the only item with that name."""

    def __init__(self):
        self.by_key: dict[tuple[str, str], Product] = {}
        self.by_name: dict[str, list[Product]] = defaultdict(list)
        for product in Product.objects.select_related("category"):
            self.add(product)

    def add(self, product: Product) -> None:
        self.by_key[(product.name.lower(), product.category.name.lower())] = product
        self.by_name[product.name.lower()].append(product)

    def find(self, name: str, category: str) -> Product | None:
        product = self.by_key.get((name.lower(), category.lower()))
        if product:
            return product
        same = self.by_name.get(name.lower(), [])
        return same[0] if len(same) == 1 else None


def _changes(row: dict, product: Product | None, again: bool = False) -> dict:
    """What importing this row does: stock to add and take off, price and bundle changes.

    Qty Add is added and QTY Removed is taken off. An amount that is the same as at the item's
    last import is held back (the sheet still shows last time's numbers) unless `again` is set.
    """
    if product is None:
        return {"add": row["added"], "remove": row["removed"], "held_add": 0, "held_remove": 0}
    last = product.import_last or {}
    held_add = row["added"] if not again and row["added"] and row["added"] == last.get("added") else 0
    held_remove = row["removed"] if not again and row["removed"] and row["removed"] == last.get("removed") else 0
    change = {
        "add": row["added"] - held_add,
        "remove": row["removed"] - held_remove,
        "held_add": held_add,
        "held_remove": held_remove,
    }
    price = row["price_paise"]
    if price is not None and price != product.price_paise and price != last.get("price", -1):
        change["price"] = (product.price_paise, price)
    if row["bundle_given"]:
        bundle = row["bundle"]
        if bundle != product.units_per_case and ("bundle" not in last or bundle != last["bundle"]):
            change["bundle"] = (product.units_per_case, bundle)
    if product.deducts_components:
        change.update(add=0, remove=0, held_add=0, held_remove=0)
    return change


def _stored_path(sha256: str) -> Path:
    if not _SHA.match(sha256 or ""):
        raise BusinessError("Upload the file again.")
    return Path(settings.DATA_DIR) / "imports" / f"{sha256}.xlsx"


def preview_import(upload) -> dict:
    data = upload.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise BusinessError("This file is too large (2 MB max).")
    sha256 = hashlib.sha256(data).hexdigest()
    rows, layout = parse_workbook(data)
    if not rows:
        raise BusinessError("No products were found in this file.")
    _stored_path(sha256).write_bytes(data)

    products = _Products()
    for row in rows:
        product = products.find(row["name"], row["category"]) if row["name"] else None
        change = _changes(row, product)
        gift_box = product.is_gift_box if product else row["category"].lower() == "gift boxes"
        if gift_box and row["bundle"]:
            row["errors"].append("Gift boxes are not sold as bundles")
        if product is not None and product.deducts_components and (row["added"] or row["removed"]):
            row["flags"].append("no_stock")
        changed = change["add"] or change["remove"] or "price" in change or "bundle" in change
        row.update(
            action="new" if product is None else "update" if changed else "same",
            product={"id": product.pk, "code": product.code, "name": product.name} if product else None,
            stock_add=change["add"],
            stock_remove=change["remove"],
            repeat_add=change["held_add"],
            repeat_remove=change["held_remove"],
            price_change=list(change["price"]) if "price" in change else None,
            bundle_change=list(change["bundle"]) if "bundle" in change else None,
        )
    done = ImportBatch.objects.filter(file_sha256=sha256).first()
    categories = sorted({r["category"] for r in rows if r["category"]} | {c for c, _ in DEFAULT_CATEGORIES})
    usable = [r for r in rows if not r["errors"]]
    return {
        "sha256": sha256,
        "file_name": getattr(upload, "name", "products.xlsx"),
        "layout": layout,
        "imported_before_at": done.created_at.isoformat() if done else None,
        "rows": rows,
        "categories": categories,
        "flag_text": FLAG_TEXT,
        "summary": {
            "products": len(rows),
            "new": sum(1 for r in usable if r["action"] == "new"),
            "update": sum(1 for r in usable if r["action"] == "update"),
            "same": sum(1 for r in usable if r["action"] == "same"),
            "with_errors": sum(1 for r in rows if r["errors"]),
        },
    }


def _category_code(name: str) -> str:
    letters = "".join(word[0] for word in re.findall(r"[A-Za-z]+", name)).upper()[:3] or "CT"
    if len(letters) == 1:
        letters = (re.sub(r"[^A-Za-z]", "", name).upper() + "X")[:2]
    code, n = letters, 1
    while Category.objects.filter(code=code).exists():
        n += 1
        code = f"{letters[:3]}{n}"[:4]
    return code


def next_product_code(category: Category) -> str:
    prefix = f"{category.code}-"
    numbers = [
        int(code[len(prefix):])
        for code in Product.objects.filter(code__startswith=prefix).values_list("code", flat=True)
        if code[len(prefix):].isdigit()
    ]
    return f"{prefix}{(max(numbers) + 1) if numbers else 1:03d}"


def confirm_import(
    user,
    *,
    sha256: str,
    file_name: str,
    categories=None,
    skip_rows=None,
    again_rows=None,
    location_id=None,
    unit_name: str = "Box",
) -> ImportBatch:
    """Apply the sheet. Rows in again_rows use their amounts even when they are the same as last time.
    location_id None means: keep stock as it is, and note the sheet's amounts as already done,
    so the next import does not add them again."""
    path = _stored_path(sha256)
    if not path.exists():
        raise BusinessError("Upload the file again.")
    rows, _layout = parse_workbook(path.read_bytes())
    category_edits = {int(row): _tidy(name)[:60] for row, name in (categories or {}).items()}
    skip = {int(r) for r in (skip_rows or [])}
    again = {int(r) for r in (again_rows or [])}
    unit_name = _tidy(unit_name)[:20] or "Box"

    with transaction.atomic():
        location = None
        if location_id:
            location = Location.objects.filter(pk=location_id, is_active=True).first()
            if location is None:
                raise BusinessError("Choose where the stock is kept.")
        ensure_default_categories()
        known = {c.name.lower(): c for c in Category.objects.all()}
        products = _Products()
        batch = ImportBatch.objects.create(
            file_name=str(file_name)[:200], file_sha256=sha256, user=user, stock_location_name=location.name if location else ""
        )
        created = updated = same = skipped = 0
        plus: dict[int, int] = {}
        minus: dict[int, int] = {}
        for row in rows:
            if row["row"] in skip:
                skipped += 1
                continue
            if row["errors"]:
                raise BusinessError(f"Row {row['row']}: {row['errors'][0]}. Fix the sheet or skip this row.")
            category_name = category_edits.get(row["row"]) or row["category"]
            product = products.find(row["name"], category_name)
            change = _changes(row, product, again=row["row"] in again)
            if product is None:
                if not category_name:
                    raise BusinessError(f"Row {row['row']}: choose a category.")
                category = known.get(category_name.lower())
                if category is None:
                    category = Category.objects.create(
                        name=category_name, code=_category_code(category_name), sort_order=len(known)
                    )
                    known[category_name.lower()] = category
                is_gift_box = category.name.lower() == "gift boxes"
                if is_gift_box and row["bundle"]:
                    raise BusinessError(f"Row {row['row']}: gift boxes are not sold as bundles.")
                product = Product.objects.create(
                    code=next_product_code(category),
                    name=row["name"][:120],
                    category=category,
                    unit_name=unit_name,
                    units_per_case=row["bundle"],
                    price_paise=row["price_paise"],
                    is_gift_box=is_gift_box,
                    source_row=row["row"],
                )
                products.add(product)
                created += 1
            else:
                fields = []
                if "price" in change:
                    product.price_paise = change["price"][1]
                    fields.append("price_paise")
                if "bundle" in change:
                    if product.is_gift_box and change["bundle"][1]:
                        raise BusinessError(f"Row {row['row']}: gift boxes are not sold as bundles.")
                    product.units_per_case = change["bundle"][1]
                    fields.append("units_per_case")
                if fields:
                    product.save(update_fields=[*fields, "updated_at"])
                if fields or (location and (change["add"] or change["remove"])):
                    updated += 1
                else:
                    same += 1
            if location and change["add"]:
                plus[product.pk] = plus.get(product.pk, 0) + change["add"]
            if location and change["remove"]:
                minus[product.pk] = minus.get(product.pk, 0) - change["remove"]
            last = dict(product.import_last or {})
            last.update(added=row["added"], removed=row["removed"], price=row["price_paise"])
            if row["bundle_given"]:
                last["bundle"] = row["bundle"]
            product.import_last = last
            product.save(update_fields=["import_last"])

        note = f"Stock sheet {file_name}"[:200]
        if plus:
            change_stock(items=plus, location=location, reason=StockMovement.Reason.SHEET_ADD, user=user,
                         ref_type="import", ref_id=batch.pk, note=note)
        if minus:
            change_stock(items=minus, location=location, reason=StockMovement.Reason.SHEET_REMOVE, user=user,
                         ref_type="import", ref_id=batch.pk, note=note)
        batch.products_created = created
        batch.products_skipped = skipped
        batch.summary = {
            "rows": len(rows),
            "updated": updated,
            "unchanged": same,
            "stock_added": sum(plus.values()),
            "stock_removed": -sum(minus.values()),
        }
        batch.save()
        audit(
            user,
            "products.import",
            f"Stock sheet {file_name}: {created} new, {updated} changed, "
            f"+{batch.summary['stock_added']} / -{batch.summary['stock_removed']} stock",
            batch,
            skipped=skipped,
        )
    return batch

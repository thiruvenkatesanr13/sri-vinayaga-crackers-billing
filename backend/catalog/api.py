import io
import re
import uuid

from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Q
from PIL import Image, UnidentifiedImageError
from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.exceptions import NotFound
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.response import Response

from core.audit import audit
from core.errors import BusinessError
from core.money import rupees
from core.permissions import IsOwner, OwnerWriteStaffRead, is_owner
from inventory.models import Location
from inventory.services import stock_totals

from .importer import _category_code, confirm_import, next_product_code, preview_import
from .models import Category, GiftBoxItem, Product


def category_payload(category: Category) -> dict:
    return {"id": category.pk, "name": category.name, "code": category.code, "sort_order": category.sort_order}


@api_view(["GET", "POST"])
@permission_classes([OwnerWriteStaffRead])
def categories_view(request):
    if request.method == "POST":
        name = re.sub(r"\s+", " ", str(request.data.get("name") or "")).strip()[:60]
        if len(name) < 2:
            raise BusinessError("Enter the category name.")
        with transaction.atomic():
            if Category.objects.filter(name__iexact=name).exists():
                raise BusinessError("This category already exists.")
            category = Category.objects.create(
                name=name, code=_category_code(name), sort_order=Category.objects.count()
            )
            audit(request.user, "category.create", f"Added category {name}", category)
        return Response(category_payload(category), status=201)
    return Response([category_payload(c) for c in Category.objects.all()])


def product_payload(product: Product, owner: bool, stock: dict, sale_location_id) -> dict:
    data = {
        "id": product.pk,
        "code": product.code,
        "name": product.name,
        "category_id": product.category_id,
        "category_name": product.category.name,
        "brand": product.brand,
        "unit_name": product.unit_name,
        "units_per_case": product.units_per_case,
        "price_paise": product.price_paise,
        "case_price_paise": product.case_price_paise,
        "low_stock_level": product.low_stock_level,
        "photo_url": product.photo.url if product.photo else None,
        "is_active": product.is_active,
        "is_gift_box": product.is_gift_box,
        "gift_box_mode": product.gift_box_mode,
        "stock": {str(k): v for k, v in stock.items()},
        "sale_stock": stock.get(sale_location_id, 0) if sale_location_id else 0,
        "box_items": [
            {"component_id": item.component_id, "quantity": item.quantity} for item in product.box_items.all()
        ]
        if product.is_gift_box
        else [],
        "updated_at": product.updated_at.isoformat(),
    }
    if owner:
        data["cost_paise"] = product.cost_paise
        data["margin_bp"] = (
            (product.price_paise - product.cost_paise) * 10000 // product.price_paise
            if product.cost_paise is not None and product.price_paise
            else None
        )
    return data


def _products_response(request, queryset):
    products = list(queryset.select_related("category").prefetch_related("box_items"))
    stock = stock_totals([p.pk for p in products])
    sale_location_id = Location.objects.filter(is_sale_location=True).values_list("pk", flat=True).first()
    owner = is_owner(request.user)
    return [product_payload(p, owner, stock.get(p.pk, {}), sale_location_id) for p in products]


def _int_or_none(value, label: str, minimum: int = 0):
    if value in (None, ""):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise BusinessError(f"Check {label}.")
    if number < minimum:
        raise BusinessError(f"{label.capitalize()} must be {minimum} or more.")
    return number


def _apply_product_fields(product: Product, data, creating: bool) -> list[str]:
    changed = []

    def set_field(name, value):
        if getattr(product, name) != value:
            setattr(product, name, value)
            changed.append(name)

    if "name" in data or creating:
        name = re.sub(r"\s+", " ", str(data.get("name") or "")).strip()[:120]
        if len(name) < 2:
            raise BusinessError("Enter the product name.")
        set_field("name", name)
    if "category_id" in data or creating:
        category = Category.objects.filter(pk=data.get("category_id")).first()
        if category is None:
            raise BusinessError("Choose a category.")
        set_field("category_id", category.pk)
    if "brand" in data:
        set_field("brand", str(data.get("brand") or "").strip()[:60])
    if "unit_name" in data:
        set_field("unit_name", str(data.get("unit_name") or "").strip()[:20] or "Box")
    if "units_per_case" in data:
        upc = _int_or_none(data.get("units_per_case"), "the bundle size", 2)
        set_field("units_per_case", upc)
    if "price_paise" in data or creating:
        price = _int_or_none(data.get("price_paise"), "the price", 1)
        if price is None:
            raise BusinessError("Enter the price.")
        set_field("price_paise", price)
    if "cost_paise" in data:
        set_field("cost_paise", _int_or_none(data.get("cost_paise"), "the purchase cost", 0))
    if "low_stock_level" in data:
        set_field("low_stock_level", _int_or_none(data.get("low_stock_level"), "the low stock level", 0))
    if "is_active" in data:
        set_field("is_active", bool(data.get("is_active")))
    if "is_gift_box" in data:
        set_field("is_gift_box", bool(data.get("is_gift_box")))
    if "gift_box_mode" in data:
        mode = data.get("gift_box_mode")
        if mode not in Product.GiftBoxMode.values:
            raise BusinessError("Choose how this gift box uses stock.")
        set_field("gift_box_mode", mode)
    return changed


@api_view(["GET", "POST"])
@permission_classes([OwnerWriteStaffRead])
def products_view(request):
    if request.method == "POST":
        with transaction.atomic():
            product = Product(code="")
            _apply_product_fields(product, request.data, creating=True)
            if Product.objects.filter(name__iexact=product.name, category_id=product.category_id).exists():
                raise BusinessError("A product with this name already exists in this category.")
            product.code = next_product_code(product.category)
            product.save()
            audit(request.user, "product.create", f"Added {product.code} {product.name}", product,
                  price_paise=product.price_paise)
        return Response(_products_response(request, Product.objects.filter(pk=product.pk))[0], status=201)

    queryset = Product.objects.all()
    if search := str(request.query_params.get("q") or "").strip():
        queryset = queryset.filter(Q(name__icontains=search) | Q(code__icontains=search))
    if category := request.query_params.get("category"):
        queryset = queryset.filter(category_id=category)
    if request.query_params.get("active") == "1":
        queryset = queryset.filter(is_active=True)
    return Response(_products_response(request, queryset))


@api_view(["GET", "PATCH"])
@permission_classes([OwnerWriteStaffRead])
def product_detail(request, product_id: int):
    product = Product.objects.select_related("category").filter(pk=product_id).first()
    if product is None:
        raise NotFound("Product not found.")
    if request.method == "PATCH":
        old_price = product.price_paise
        with transaction.atomic():
            changed = _apply_product_fields(product, request.data, creating=False)
            if "name" in changed or "category_id" in changed:
                if Product.objects.filter(name__iexact=product.name, category_id=product.category_id).exclude(
                    pk=product.pk
                ).exists():
                    raise BusinessError("A product with this name already exists in this category.")
            if not product.is_gift_box and product.box_items.exists():
                product.box_items.all().delete()
            product.save()
            if "price_paise" in changed:
                audit(
                    request.user,
                    "product.price",
                    f"{product.code} {product.name}: {rupees(old_price)} -> {rupees(product.price_paise)}",
                    product,
                    old_paise=old_price,
                    new_paise=product.price_paise,
                )
            elif changed:
                audit(request.user, "product.update", f"Changed {', '.join(changed)} for {product.code}", product)
    return Response(_products_response(request, Product.objects.filter(pk=product.pk))[0])


@api_view(["POST", "DELETE"])
@permission_classes([IsOwner])
@parser_classes([MultiPartParser])
def product_photo(request, product_id: int):
    product = Product.objects.filter(pk=product_id).first()
    if product is None:
        raise NotFound("Product not found.")
    old = product.photo.name if product.photo else None
    if request.method == "DELETE":
        product.photo = ""
        product.save(update_fields=["photo", "updated_at"])
    else:
        upload = request.FILES.get("photo")
        if upload is None:
            raise BusinessError("Choose a photo.")
        if upload.size > 5 * 1024 * 1024:
            raise BusinessError("Photo is too large (5 MB max).")
        try:
            image = Image.open(upload)
            image.verify()
            upload.seek(0)
            image = Image.open(upload)
            image = image.convert("RGB")
        except (UnidentifiedImageError, OSError, ValueError):
            raise BusinessError("This file is not a photo. Use a JPG or PNG.")
        image.thumbnail((480, 480))
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=82, optimize=True)
        product.photo.save(f"{product.code}-{uuid.uuid4().hex[:8]}.jpg", ContentFile(buffer.getvalue()), save=False)
        product.save(update_fields=["photo", "updated_at"])
    if old and old != (product.photo.name if product.photo else None):
        product.photo.storage.delete(old)
    return Response(_products_response(request, Product.objects.filter(pk=product.pk))[0])


@api_view(["PUT"])
@permission_classes([IsOwner])
def gift_box_items(request, product_id: int):
    box = Product.objects.filter(pk=product_id, is_gift_box=True).first()
    if box is None:
        raise NotFound("Gift box not found.")
    items = request.data.get("items") or []
    cleaned: dict[int, int] = {}
    for item in items:
        try:
            component_id, quantity = int(item["component_id"]), int(item["quantity"])
        except (KeyError, TypeError, ValueError):
            raise BusinessError("Each item needs a product and a quantity.")
        if quantity <= 0:
            raise BusinessError("Quantities must be more than zero.")
        if component_id == box.pk:
            raise BusinessError("A gift box cannot contain itself.")
        cleaned[component_id] = cleaned.get(component_id, 0) + quantity
    components = Product.objects.in_bulk(list(cleaned))
    if missing := set(cleaned) - set(components):
        raise BusinessError(f"Unknown product(s): {sorted(missing)}")
    if any(c.is_gift_box for c in components.values()):
        raise BusinessError("A gift box cannot contain another gift box.")
    with transaction.atomic():
        box.box_items.all().delete()
        GiftBoxItem.objects.bulk_create(
            [GiftBoxItem(gift_box=box, component_id=cid, quantity=qty) for cid, qty in cleaned.items()]
        )
        audit(request.user, "giftbox.items", f"Set {len(cleaned)} items inside {box.name}", box)
    return Response(_products_response(request, Product.objects.filter(pk=box.pk))[0])


@api_view(["POST"])
@permission_classes([IsOwner])
@parser_classes([MultiPartParser])
def import_preview(request):
    upload = request.FILES.get("file")
    if upload is None:
        raise BusinessError("Choose the Excel file.")
    if not upload.name.lower().endswith(".xlsx"):
        raise BusinessError("Use an Excel .xlsx file.")
    return Response(preview_import(upload))


@api_view(["POST"])
@permission_classes([IsOwner])
@parser_classes([JSONParser])
def import_confirm(request):
    data = request.data
    categories = data.get("categories") or {}
    if not isinstance(categories, dict):
        raise BusinessError("Invalid request.")
    batch = confirm_import(
        request.user,
        sha256=str(data.get("sha256") or ""),
        file_name=str(data.get("file_name") or "products.xlsx"),
        categories=categories,
        skip_rows=data.get("skip_rows") or [],
        again_rows=data.get("again_rows") or [],
        location_id=data.get("location_id"),
        unit_name=data.get("unit_name") or "Box",
    )
    return Response(
        {
            "id": batch.pk,
            "products_created": batch.products_created,
            "products_updated": batch.summary.get("updated", 0),
            "products_unchanged": batch.summary.get("unchanged", 0),
            "products_skipped": batch.products_skipped,
            "stock_added": batch.summary.get("stock_added", 0),
            "stock_removed": batch.summary.get("stock_removed", 0),
            "stock_location": batch.stock_location_name,
        },
        status=201,
    )

"""Stock rules: every change goes through change_stock(), inside a transaction.

Balances can never go below zero (checked here and enforced by the database),
and every change is written to the permanent StockMovement history.
"""

from collections import defaultdict

from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from catalog.models import Product
from core.audit import audit
from core.errors import BusinessError, ConflictError
from core.money import div_half_up

from .models import (
    Location,
    Purchase,
    PurchaseLine,
    StockAdjustment,
    StockBalance,
    StockMovement,
    StockTransfer,
    StockTransferLine,
    Supplier,
)

Reason = StockMovement.Reason


class StockShortage(ConflictError):
    default_code = "insufficient_stock"


def _require_atomic():
    if not transaction.get_connection().in_atomic_block:
        raise RuntimeError("Stock changes must run inside transaction.atomic()")


def sale_location() -> Location:
    location = Location.objects.filter(is_sale_location=True, is_active=True).first()
    if location is None:
        raise BusinessError(
            "No shop location is set for billing. Ask the owner to check Settings.", code="no_sale_location"
        )
    return location


def shortage_error(location: Location, shortages: dict[int, tuple[int, int]]) -> StockShortage:
    """shortages: product_id -> (needed, available)."""
    products = Product.objects.in_bulk(list(shortages))
    items = []
    for product_id, (needed, available) in shortages.items():
        product = products.get(product_id)
        items.append(
            {
                "product_id": product_id,
                "code": product.code if product else "",
                "name": product.name if product else "",
                "unit": product.unit_name if product else "",
                "needed": needed,
                "available": available,
            }
        )
    names = ", ".join(f"{i['name']} (only {i['available']} left)" for i in items)
    return StockShortage(f"Not enough stock at {location.name}: {names}", items=items)


def change_stock(
    *,
    items: dict[int, int],
    location: Location,
    reason: str,
    user=None,
    ref_type: str = "",
    ref_id: str | int = "",
    note: str = "",
) -> None:
    """Apply signed changes (product_id -> +/- quantity) at one location."""
    _require_atomic()
    items = {pid: qty for pid, qty in items.items() if qty}
    if not items:
        return

    existing = set(
        StockBalance.objects.filter(location=location, product_id__in=items).values_list("product_id", flat=True)
    )
    StockBalance.objects.bulk_create(
        [StockBalance(product_id=pid, location=location, quantity=0) for pid in items if pid not in existing]
    )

    needs = {pid: -qty for pid, qty in items.items() if qty < 0}
    if needs:
        balances = dict(
            StockBalance.objects.filter(location=location, product_id__in=needs).values_list("product_id", "quantity")
        )
        short = {pid: (need, balances.get(pid, 0)) for pid, need in needs.items() if balances.get(pid, 0) < need}
        if short:
            raise shortage_error(location, short)

    for product_id, qty in items.items():
        rows = StockBalance.objects.filter(location=location, product_id=product_id)
        if qty < 0:
            rows = rows.filter(quantity__gte=-qty)
        if rows.update(quantity=F("quantity") + qty) != 1:
            available = StockBalance.objects.filter(location=location, product_id=product_id).values_list(
                "quantity", flat=True
            )
            raise shortage_error(location, {product_id: (-qty, next(iter(available), 0))})
        after = StockBalance.objects.values_list("quantity", flat=True).get(location=location, product_id=product_id)
        StockMovement.objects.create(
            product_id=product_id,
            location=location,
            change=qty,
            balance_after=after,
            reason=reason,
            ref_type=ref_type,
            ref_id=str(ref_id),
            note=note[:200],
            user=user,
        )


def _clean_lines(lines) -> dict[int, int]:
    totals: dict[int, int] = defaultdict(int)
    for line in lines:
        product_id, quantity = int(line["product_id"]), int(line["quantity"])
        if quantity <= 0:
            raise BusinessError("Quantities must be more than zero.")
        totals[product_id] += quantity
    if not totals:
        raise BusinessError("Add at least one item.")
    found = set(Product.objects.filter(pk__in=totals).values_list("pk", flat=True))
    if missing := set(totals) - found:
        raise BusinessError(f"Unknown product(s): {sorted(missing)}")
    return dict(totals)


def _active_location(location_id) -> Location:
    location = Location.objects.filter(pk=location_id, is_active=True).first()
    if location is None:
        raise BusinessError("Choose a valid location.")
    return location


def create_transfer(*, user, lines, from_location_id=None, to_location_id=None, note=""):
    """Move stock from one place to another, e.g. from the godown to the shop."""
    quantities = _clean_lines(lines)
    with transaction.atomic():
        source, target = _active_location(from_location_id), _active_location(to_location_id)
        if source.pk == target.pk:
            raise BusinessError("Choose two different places to move stock between.")
        transfer = StockTransfer.objects.create(from_location=source, to_location=target, note=note[:200], user=user)
        StockTransferLine.objects.bulk_create(
            [StockTransferLine(transfer=transfer, product_id=pid, quantity=qty) for pid, qty in quantities.items()]
        )
        label = f"Move #{transfer.pk}"
        change_stock(
            items={pid: -qty for pid, qty in quantities.items()},
            location=source,
            reason=Reason.TRANSFER_OUT,
            user=user,
            ref_type="transfer",
            ref_id=transfer.pk,
            note=label,
        )
        change_stock(
            items=quantities,
            location=target,
            reason=Reason.TRANSFER_IN,
            user=user,
            ref_type="transfer",
            ref_id=transfer.pk,
            note=label,
        )
        audit(
            user, "stock.move", f"{label}: {source.name} to {target.name}", transfer, lines=len(quantities)
        )
    return transfer


def create_adjustment(*, user, kind: str, product_id: int, location_id: int, counted=None, quantity=None, note=""):
    with transaction.atomic():
        location = _active_location(location_id)
        product = Product.objects.filter(pk=product_id).first()
        if product is None:
            raise BusinessError("Choose a product.")
        balance = (
            StockBalance.objects.filter(product=product, location=location).values_list("quantity", flat=True).first()
            or 0
        )
        if kind == StockAdjustment.Kind.COUNT:
            if counted is None or int(counted) < 0:
                raise BusinessError("Enter the counted quantity (0 or more).")
            counted = int(counted)
            difference = counted - balance
        elif kind == StockAdjustment.Kind.DAMAGE:
            if quantity is None or int(quantity) <= 0:
                raise BusinessError("Enter how many are damaged.")
            quantity = int(quantity)
            if quantity > balance:
                raise BusinessError(f"Only {balance} {product.unit_name} in stock at {location.name}.")
            difference = -quantity
            counted = balance - quantity
        else:
            raise BusinessError("Unknown adjustment type.")

        adjustment = StockAdjustment.objects.create(
            kind=kind,
            product=product,
            location=location,
            expected=balance,
            counted=counted,
            difference=difference,
            note=note[:200],
            user=user,
        )
        if difference:
            change_stock(
                items={product.pk: difference},
                location=location,
                reason=Reason.COUNT if kind == StockAdjustment.Kind.COUNT else Reason.DAMAGE,
                user=user,
                ref_type="adjustment",
                ref_id=adjustment.pk,
                note=note,
            )
        audit(
            user,
            f"stock.{kind}",
            f"{product.name} at {location.name}: {balance} -> {counted}",
            adjustment,
            difference=difference,
        )
    return adjustment


def allocate_transport(values: list[int], transport_paise: int) -> list[int]:
    """Split transport charges across lines by value; shares always add up exactly."""
    if transport_paise <= 0 or not values:
        return [0] * len(values)
    total = sum(values)
    weights = values if total > 0 else [1] * len(values)
    weight_total = sum(weights)
    shares = [div_half_up(transport_paise * w, weight_total) for w in weights]
    shares[-1] += transport_paise - sum(shares)
    return shares


def create_purchase(
    *, user, bill_date, location_id, lines, supplier_id=None, bill_number="", transport_paise=0, note=""
):
    if transport_paise < 0:
        raise BusinessError("Transport charges cannot be negative.")
    cleaned = []
    for line in lines:
        quantity, unit_cost = int(line["quantity"]), int(line["unit_cost_paise"])
        if quantity <= 0 or unit_cost < 0:
            raise BusinessError("Each line needs a quantity above 0 and a cost of 0 or more.")
        cleaned.append((int(line["product_id"]), quantity, unit_cost))
    if not cleaned:
        raise BusinessError("Add at least one item.")

    with transaction.atomic():
        location = _active_location(location_id)
        supplier = Supplier.objects.filter(pk=supplier_id).first() if supplier_id else None
        if supplier_id and supplier is None:
            raise BusinessError("Choose a valid supplier.")
        products = Product.objects.in_bulk([pid for pid, _, _ in cleaned])
        if missing := {pid for pid, _, _ in cleaned} - set(products):
            raise BusinessError(f"Unknown product(s): {sorted(missing)}")

        values = [qty * cost for _, qty, cost in cleaned]
        shares = allocate_transport(values, transport_paise)
        purchase = Purchase.objects.create(
            supplier=supplier,
            bill_number=bill_number[:40],
            bill_date=bill_date,
            location=location,
            transport_paise=transport_paise,
            goods_paise=sum(values),
            note=note[:200],
            user=user,
        )

        on_hand = dict(
            StockBalance.objects.filter(product_id__in=products)
            .values("product_id")
            .annotate(total=Sum("quantity"))
            .values_list("product_id", "total")
        )
        received: dict[int, int] = defaultdict(int)
        for (product_id, quantity, unit_cost), share in zip(cleaned, shares):
            landed = unit_cost + div_half_up(share, quantity)
            PurchaseLine.objects.create(
                purchase=purchase,
                product_id=product_id,
                quantity=quantity,
                unit_cost_paise=unit_cost,
                landed_unit_cost_paise=landed,
            )
            product = products[product_id]
            existing = on_hand.get(product_id, 0) + received[product_id]
            # Weighted average cost. Stock with no known cost takes the new cost.
            if product.cost_paise is None or existing <= 0:
                new_cost = landed
            else:
                new_cost = div_half_up(product.cost_paise * existing + landed * quantity, existing + quantity)
            if new_cost != product.cost_paise:
                product.cost_paise = new_cost
                product.save(update_fields=["cost_paise", "updated_at"])
            received[product_id] += quantity

        change_stock(
            items=dict(received),
            location=location,
            reason=Reason.PURCHASE,
            user=user,
            ref_type="purchase",
            ref_id=purchase.pk,
            note=f"Bill {bill_number}".strip(),
        )
        audit(user, "purchase.create", f"Purchase {bill_number or purchase.pk} into {location.name}", purchase)
    return purchase


def stock_totals(product_ids=None) -> dict[int, dict[int, int]]:
    """product_id -> {location_id: quantity}."""
    rows = StockBalance.objects.all()
    if product_ids is not None:
        rows = rows.filter(product_id__in=product_ids)
    result: dict[int, dict[int, int]] = defaultdict(dict)
    for product_id, location_id, quantity in rows.values_list("product_id", "location_id", "quantity"):
        result[product_id][location_id] = quantity
    return result


def today():
    return timezone.localdate()

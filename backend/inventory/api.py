from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.audit import audit
from core.errors import BusinessError
from core.permissions import IsOwner, OwnerWriteStaffRead

from .models import Location, Purchase, StockAdjustment, StockMovement, StockTransfer, Supplier
from .services import create_adjustment, create_purchase, create_transfer


def location_payload(location: Location) -> dict:
    return {
        "id": location.pk,
        "name": location.name,
        "kind": location.kind,
        "is_active": location.is_active,
        "is_sale_location": location.is_sale_location,
    }


@api_view(["GET", "POST"])
@permission_classes([OwnerWriteStaffRead])
def locations_view(request):
    if request.method == "POST":
        name = str(request.data.get("name") or "").strip()[:60]
        kind = request.data.get("kind") or Location.Kind.GODOWN
        if len(name) < 2 or kind not in Location.Kind.values:
            raise BusinessError("Enter a name and choose Shop or Godown.")
        with transaction.atomic():
            if Location.objects.filter(name__iexact=name).exists():
                raise BusinessError("A place with this name already exists.")
            location = Location.objects.create(name=name, kind=kind)
            audit(request.user, "location.create", f"Added {name}", location)
        return Response(location_payload(location), status=201)
    return Response([location_payload(loc) for loc in Location.objects.all()])


@api_view(["PATCH"])
@permission_classes([IsOwner])
def location_detail(request, location_id: int):
    location = Location.objects.filter(pk=location_id).first()
    if location is None:
        raise NotFound("Place not found.")
    with transaction.atomic():
        if "name" in request.data:
            name = str(request.data["name"] or "").strip()[:60]
            if len(name) < 2:
                raise BusinessError("Enter a name.")
            if Location.objects.filter(name__iexact=name).exclude(pk=location.pk).exists():
                raise BusinessError("A place with this name already exists.")
            location.name = name
        if "is_active" in request.data:
            if location.is_sale_location and not request.data["is_active"]:
                raise BusinessError("The billing shop cannot be turned off.")
            location.is_active = bool(request.data["is_active"])
        location.save()
        audit(request.user, "location.update", f"Updated {location.name}", location)
    return Response(location_payload(location))


def _date(value, default=None):
    if not value:
        return default
    parsed = parse_date(str(value))
    if parsed is None:
        raise BusinessError("Dates should look like 2026-10-26.")
    return parsed


def _limit(request, default=100, maximum=500) -> tuple[int, int]:
    try:
        limit = min(max(int(request.query_params.get("limit", default)), 1), maximum)
        offset = max(int(request.query_params.get("offset", 0)), 0)
    except ValueError:
        raise BusinessError("Invalid page.")
    return limit, offset


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def movements_view(request):
    rows = StockMovement.objects.select_related("product", "location", "user")
    params = request.query_params
    if params.get("product"):
        rows = rows.filter(product_id=params["product"])
    if params.get("location"):
        rows = rows.filter(location_id=params["location"])
    if params.get("reason"):
        rows = rows.filter(reason=params["reason"])
    if start := _date(params.get("from")):
        rows = rows.filter(created_at__date__gte=start)
    if end := _date(params.get("to")):
        rows = rows.filter(created_at__date__lte=end)
    limit, offset = _limit(request)
    total = rows.count()
    return Response(
        {
            "count": total,
            "results": [
                {
                    "id": m.pk,
                    "at": m.created_at.isoformat(),
                    "product_id": m.product_id,
                    "product_code": m.product.code,
                    "product_name": m.product.name,
                    "unit": m.product.unit_name,
                    "location": m.location.name,
                    "change": m.change,
                    "balance_after": m.balance_after,
                    "reason": m.reason,
                    "reason_label": m.get_reason_display(),
                    "note": m.note,
                    "user": m.user.display_name if m.user else "",
                }
                for m in rows[offset : offset + limit]
            ],
        }
    )


def transfer_payload(transfer: StockTransfer) -> dict:
    return {
        "id": transfer.pk,
        "from_location": transfer.from_location.name,
        "to_location": transfer.to_location.name,
        "note": transfer.note,
        "user": transfer.user.display_name if transfer.user else "",
        "at": transfer.created_at.isoformat(),
        "lines": [
            {"product_id": l.product_id, "code": l.product.code, "name": l.product.name, "quantity": l.quantity}
            for l in transfer.lines.select_related("product")
        ],
    }


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def transfers_view(request):
    if request.method == "POST":
        data = request.data
        transfer = create_transfer(
            user=request.user,
            lines=data.get("lines") or [],
            from_location_id=data.get("from_location_id"),
            to_location_id=data.get("to_location_id"),
            note=str(data.get("note") or ""),
        )
        return Response(transfer_payload(transfer), status=201)
    rows = StockTransfer.objects.select_related("from_location", "to_location", "user")[:100]
    return Response([transfer_payload(t) for t in rows])


@api_view(["GET", "POST"])
@permission_classes([IsOwner])
def adjustments_view(request):
    if request.method == "POST":
        data = request.data
        adjustment = create_adjustment(
            user=request.user,
            kind=data.get("kind"),
            product_id=data.get("product_id"),
            location_id=data.get("location_id"),
            counted=data.get("counted"),
            quantity=data.get("quantity"),
            note=str(data.get("note") or ""),
        )
        return Response({"id": adjustment.pk, "difference": adjustment.difference}, status=201)
    rows = StockAdjustment.objects.select_related("product", "location", "user")[:200]
    return Response(
        [
            {
                "id": a.pk,
                "kind": a.kind,
                "product": f"{a.product.code} {a.product.name}",
                "location": a.location.name,
                "expected": a.expected,
                "counted": a.counted,
                "difference": a.difference,
                "note": a.note,
                "user": a.user.display_name if a.user else "",
                "at": a.created_at.isoformat(),
            }
            for a in rows
        ]
    )


def supplier_payload(supplier: Supplier) -> dict:
    return {"id": supplier.pk, "name": supplier.name, "phone": supplier.phone, "gstin": supplier.gstin}


@api_view(["GET", "POST"])
@permission_classes([IsOwner])
def suppliers_view(request):
    if request.method == "POST":
        name = str(request.data.get("name") or "").strip()[:100]
        if len(name) < 2:
            raise BusinessError("Enter the supplier name.")
        with transaction.atomic():
            if Supplier.objects.filter(name__iexact=name).exists():
                raise BusinessError("This supplier already exists.")
            supplier = Supplier.objects.create(
                name=name,
                phone=str(request.data.get("phone") or "").strip()[:20],
                gstin=str(request.data.get("gstin") or "").strip().upper()[:15],
            )
        return Response(supplier_payload(supplier), status=201)
    return Response([supplier_payload(s) for s in Supplier.objects.all()])


@api_view(["PATCH"])
@permission_classes([IsOwner])
def supplier_detail(request, supplier_id: int):
    supplier = Supplier.objects.filter(pk=supplier_id).first()
    if supplier is None:
        raise NotFound("Supplier not found.")
    for field, size in (("name", 100), ("phone", 20), ("gstin", 15)):
        if field in request.data:
            value = str(request.data[field] or "").strip()[:size]
            setattr(supplier, field, value.upper() if field == "gstin" else value)
    if len(supplier.name) < 2:
        raise BusinessError("Enter the supplier name.")
    supplier.save()
    return Response(supplier_payload(supplier))


def purchase_payload(purchase: Purchase) -> dict:
    return {
        "id": purchase.pk,
        "supplier": purchase.supplier.name if purchase.supplier else "",
        "bill_number": purchase.bill_number,
        "bill_date": purchase.bill_date.isoformat(),
        "location": purchase.location.name,
        "goods_paise": purchase.goods_paise,
        "transport_paise": purchase.transport_paise,
        "total_paise": purchase.goods_paise + purchase.transport_paise,
        "note": purchase.note,
        "user": purchase.user.display_name if purchase.user else "",
        "at": purchase.created_at.isoformat(),
        "lines": [
            {
                "product_id": l.product_id,
                "code": l.product.code,
                "name": l.product.name,
                "quantity": l.quantity,
                "unit_cost_paise": l.unit_cost_paise,
                "landed_unit_cost_paise": l.landed_unit_cost_paise,
            }
            for l in purchase.lines.select_related("product")
        ],
    }


@api_view(["GET", "POST"])
@permission_classes([IsOwner])
def purchases_view(request):
    if request.method == "POST":
        data = request.data
        try:
            transport = int(data.get("transport_paise") or 0)
        except (TypeError, ValueError):
            raise BusinessError("Check the transport charges.")
        purchase = create_purchase(
            user=request.user,
            supplier_id=data.get("supplier_id"),
            bill_number=str(data.get("bill_number") or "").strip(),
            bill_date=_date(data.get("bill_date"), timezone.localdate()),
            location_id=data.get("location_id"),
            transport_paise=transport,
            lines=data.get("lines") or [],
            note=str(data.get("note") or ""),
        )
        return Response(purchase_payload(purchase), status=201)
    rows = Purchase.objects.select_related("supplier", "location", "user")[:100]
    return Response([purchase_payload(p) for p in rows])

import uuid

from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.errors import BusinessError
from core.permissions import IsOwner, is_owner

from .models import Booking, Customer, HeldBill, Invoice, Payment
from .services import (
    add_booking_payment,
    booking_advance,
    cancel_booking,
    cancel_invoice,
    clean_phone,
    create_booking,
    create_invoice,
    hold_bill,
    mark_printed,
    update_booking,
    validate_phone,
)


def _date(value):
    if not value:
        return None
    parsed = parse_date(str(value))
    if parsed is None:
        raise BusinessError("Dates should look like 2026-10-26.")
    return parsed


def _page(request, default=50, maximum=200) -> tuple[int, int]:
    try:
        limit = min(max(int(request.query_params.get("limit", default)), 1), maximum)
        offset = max(int(request.query_params.get("offset", 0)), 0)
    except ValueError:
        raise BusinessError("Invalid page.")
    return limit, offset


def payment_payload(payment: Payment) -> dict:
    return {
        "id": payment.pk,
        "kind": payment.kind,
        "mode": payment.mode,
        "mode_label": payment.get_mode_display(),
        "amount_paise": payment.amount_paise,
        "reference": payment.reference,
        "cash_tendered_paise": payment.cash_tendered_paise,
        "change_paise": payment.change_paise,
        "business_date": payment.business_date.isoformat(),
        "at": payment.created_at.isoformat(),
    }


def invoice_summary(invoice: Invoice) -> dict:
    return {
        "id": invoice.pk,
        "number": invoice.number,
        "doc_type": invoice.doc_type,
        "status": invoice.status,
        "business_date": invoice.business_date.isoformat(),
        "at": invoice.created_at.isoformat(),
        "counter_name": invoice.counter_name,
        "user_name": invoice.user_name,
        "customer_name": invoice.customer_name,
        "customer_phone": invoice.customer_phone,
        "total_paise": invoice.total_paise,
        "print_count": invoice.print_count,
    }


def invoice_detail_payload(invoice: Invoice, owner: bool) -> dict:
    data = invoice_summary(invoice)
    data.update(
        {
            "client_uuid": str(invoice.client_uuid),
            "subtotal_paise": invoice.subtotal_paise,
            "discount_bp": invoice.discount_bp,
            "discount_paise": invoice.discount_paise,
            "taxable_paise": invoice.taxable_paise,
            "gst_rate_bp": invoice.gst_rate_bp,
            "prices_include_gst": invoice.prices_include_gst,
            "cgst_paise": invoice.cgst_paise,
            "sgst_paise": invoice.sgst_paise,
            "round_off_paise": invoice.round_off_paise,
            "advance_paise": invoice.advance_paise,
            "amount_due_paise": invoice.amount_due_paise,
            "booking_number": invoice.booking.number if invoice.booking_id else None,
            "shop": invoice.shop,
            "cancelled_at": invoice.cancelled_at.isoformat() if invoice.cancelled_at else None,
            "cancelled_by": invoice.cancelled_by.display_name if invoice.cancelled_by_id else None,
            "cancel_reason": invoice.cancel_reason,
            "lines": [
                {
                    "line_no": l.line_no,
                    "product_id": l.product_id,
                    "code": l.product_code,
                    "name": l.product_name,
                    "category": l.category_name,
                    "sale_unit": l.sale_unit,
                    "unit_label": l.unit_label,
                    "qty": l.qty,
                    "base_qty": l.base_qty,
                    "unit_price_paise": l.unit_price_paise,
                    "amount_paise": l.amount_paise,
                    "group_label": l.group_label,
                }
                for l in invoice.lines.all()
            ],
            "payments": [payment_payload(p) for p in invoice.payments.all()],
        }
    )
    if owner:
        data["cost_paise"] = invoice.cost_paise
    return data


def _load_invoice(invoice_id) -> Invoice:
    invoice = (
        Invoice.objects.select_related("booking", "cancelled_by")
        .prefetch_related("lines", "payments")
        .filter(pk=invoice_id)
        .first()
    )
    if invoice is None:
        raise NotFound("Bill not found.")
    return invoice


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def bills_view(request):
    if request.method == "POST":
        data = dict(request.data)
        try:
            data["client_uuid"] = uuid.UUID(str(data.get("client_uuid")))
        except ValueError:
            raise BusinessError("This bill is missing its id. Reload the page and try again.")
        invoice, created = create_invoice(request.user, data)
        return Response(
            invoice_detail_payload(_load_invoice(invoice.pk), is_owner(request.user)),
            status=201 if created else 200,
        )

    params = request.query_params
    rows = Invoice.objects.all()
    if q := str(params.get("q") or "").strip():
        digits = clean_phone(q)
        condition = Q(number__icontains=q) | Q(customer_name__icontains=q)
        if digits:
            condition |= Q(customer_phone__contains=digits)
        rows = rows.filter(condition)
    if start := _date(params.get("from")):
        rows = rows.filter(business_date__gte=start)
    if end := _date(params.get("to")):
        rows = rows.filter(business_date__lte=end)
    for field in ("status", "doc_type", "counter_name"):
        if value := params.get(field):
            rows = rows.filter(**{field: value})
    if user_id := params.get("user"):
        rows = rows.filter(user_id=user_id)
    limit, offset = _page(request)
    total = rows.count()
    totals = rows.filter(status=Invoice.Status.ACTIVE).aggregate(total=Sum("total_paise"))
    return Response(
        {
            "count": total,
            "active_total_paise": totals["total"] or 0,
            "results": [invoice_summary(i) for i in rows[offset : offset + limit]],
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def bill_detail(request, invoice_id: int):
    return Response(invoice_detail_payload(_load_invoice(invoice_id), is_owner(request.user)))


@api_view(["POST"])
@permission_classes([IsOwner])
def bill_cancel(request, invoice_id: int):
    invoice = cancel_invoice(request.user, invoice_id, str(request.data.get("reason") or ""))
    return Response(invoice_detail_payload(_load_invoice(invoice.pk), True))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def bill_printed(request, invoice_id: int):
    count = mark_printed(invoice_id)
    return Response({"print_count": count, "duplicate": count > 1})


# Held bills ----------------------------------------------------------------


def held_payload(held: HeldBill) -> dict:
    return {
        "id": held.pk,
        "counter_id": held.counter_id,
        "label": held.label,
        "total_paise": held.total_paise,
        "payload": held.payload,
        "user_name": held.user.display_name,
        "at": held.created_at.isoformat(),
    }


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def held_bills_view(request):
    if request.method == "POST":
        data = request.data
        held = hold_bill(
            request.user, data.get("counter_id"), data.get("label") or "", data.get("payload"), data.get("total_paise")
        )
        return Response(held_payload(held), status=201)
    rows = HeldBill.objects.select_related("user")
    if counter_id := request.query_params.get("counter"):
        rows = rows.filter(counter_id=counter_id)
    return Response([held_payload(h) for h in rows])


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def held_bill_detail(request, held_id: int):
    deleted, _ = HeldBill.objects.filter(pk=held_id).delete()
    if not deleted:
        raise NotFound("This held bill was already resumed or removed.")
    return Response(status=204)


# Customers ----------------------------------------------------------------


def customer_payload(customer: Customer) -> dict:
    return {"id": customer.pk, "name": customer.name, "phone": customer.phone, "kind": customer.kind}


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def customers_view(request):
    if request.method == "POST":
        data = request.data
        kind = data.get("kind") or Customer.Kind.WALK_IN
        if kind not in Customer.Kind.values:
            raise BusinessError("Choose Walk-in, Regular or Dealer.")
        name = str(data.get("name") or "").strip()[:80]
        phone = validate_phone(data.get("phone"))
        if not name and not phone:
            raise BusinessError("Enter a name or phone number.")
        with transaction.atomic():
            if phone and Customer.objects.filter(phone=phone).exists():
                raise BusinessError("A customer with this phone number already exists.")
            customer = Customer.objects.create(name=name, phone=phone, kind=kind)
        return Response(customer_payload(customer), status=201)

    rows = Customer.objects.all()
    if q := str(request.query_params.get("q") or "").strip():
        digits = clean_phone(q)
        condition = Q(name__icontains=q)
        if digits:
            condition |= Q(phone__startswith=digits)
        rows = rows.filter(condition)
    if kind := request.query_params.get("kind"):
        rows = rows.filter(kind=kind)
    limit, offset = _page(request, default=50)
    return Response(
        {"count": rows.count(), "results": [customer_payload(c) for c in rows[offset : offset + limit]]}
    )


@api_view(["PATCH"])
@permission_classes([IsAuthenticated])
def customer_detail(request, customer_id: int):
    customer = Customer.objects.filter(pk=customer_id).first()
    if customer is None:
        raise NotFound("Customer not found.")
    data = request.data
    with transaction.atomic():
        if "name" in data:
            customer.name = str(data["name"] or "").strip()[:80]
        if "phone" in data:
            phone = validate_phone(data["phone"])
            if phone and Customer.objects.filter(phone=phone).exclude(pk=customer.pk).exists():
                raise BusinessError("Another customer has this phone number.")
            customer.phone = phone
        if "kind" in data:
            if data["kind"] not in Customer.Kind.values:
                raise BusinessError("Choose Walk-in, Regular or Dealer.")
            customer.kind = data["kind"]
        if not customer.name and not customer.phone:
            raise BusinessError("Enter a name or phone number.")
        customer.save()
    return Response(customer_payload(customer))


# Bookings ----------------------------------------------------------------


def booking_payload(booking: Booking, detail: bool = False) -> dict:
    advance = booking_advance(booking)
    data = {
        "id": booking.pk,
        "number": booking.number,
        "status": booking.status,
        "customer_name": booking.customer_name,
        "customer_phone": booking.customer_phone,
        "address": booking.address,
        "delivery_date": booking.delivery_date.isoformat(),
        "note": booking.note,
        "estimate_paise": booking.estimate_paise,
        "advance_paise": advance,
        "created_at": booking.created_at.isoformat(),
        "cancelled_reason": booking.cancelled_reason,
        "bill": next(
            (
                {"id": i.pk, "number": i.number, "total_paise": i.total_paise}
                for i in booking.invoices.all()
                if i.status == Invoice.Status.ACTIVE
            ),
            None,
        ),
    }
    if detail:
        data["lines"] = [
            {
                "product_id": line.product_id,
                "code": line.product.code,
                "name": line.product.name,
                "sale_unit": line.sale_unit,
                "qty": line.qty,
                "price_paise": line.product.price_paise,
                "units_per_case": line.product.units_per_case,
                "unit_name": line.product.unit_name,
            }
            for line in booking.lines.select_related("product")
        ]
        data["payments"] = [payment_payload(p) for p in booking.payments.all()]
    return data


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def bookings_view(request):
    if request.method == "POST":
        data = dict(request.data)
        data["delivery_date"] = _date(data.get("delivery_date"))
        booking = create_booking(request.user, data)
        return Response(booking_payload(booking, detail=True), status=201)
    rows = Booking.objects.prefetch_related("invoices", "payments")
    params = request.query_params
    if status := params.get("status"):
        if status == "open":
            rows = rows.filter(status__in=[Booking.Status.BOOKED, Booking.Status.READY])
        else:
            rows = rows.filter(status=status)
    if q := str(params.get("q") or "").strip():
        rows = rows.filter(Q(number__icontains=q) | Q(customer_name__icontains=q) | Q(customer_phone__contains=q))
    if params.get("due") == "soon":
        rows = rows.filter(delivery_date__lte=timezone.localdate() + timezone.timedelta(days=1))
    return Response([booking_payload(b) for b in rows[:300]])


@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def booking_detail(request, booking_id: int):
    note = None
    if request.method == "PATCH":
        data = dict(request.data)
        if "delivery_date" in data:
            data["delivery_date"] = _date(data["delivery_date"])
        note = getattr(update_booking(request.user, booking_id, data), "advance_note", None)
    booking = Booking.objects.prefetch_related("invoices", "payments").filter(pk=booking_id).first()
    if booking is None:
        raise NotFound("Booking not found.")
    payload = booking_payload(booking, detail=True)
    if note:
        payload["advance_note"] = note
    return Response(payload)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def booking_payment(request, booking_id: int):
    add_booking_payment(request.user, booking_id, request.data)
    booking = Booking.objects.prefetch_related("invoices", "payments").get(pk=booking_id)
    return Response(booking_payload(booking, detail=True), status=201)


@api_view(["POST"])
@permission_classes([IsOwner])
def booking_cancel(request, booking_id: int):
    cancel_booking(
        request.user, booking_id, str(request.data.get("reason") or ""), request.data.get("refund_mode")
    )
    booking = Booking.objects.prefetch_related("invoices", "payments").get(pk=booking_id)
    return Response(booking_payload(booking, detail=True))

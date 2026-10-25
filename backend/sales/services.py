"""Billing rules: pricing, saving a bill exactly once, cancelling, bookings."""

import re
from collections import defaultdict
from dataclasses import dataclass

from django.db import IntegrityError, transaction
from django.db.models import F, Sum
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied

from catalog.models import Product
from core.audit import audit
from core.errors import BusinessError, ConflictError
from core.models import Counter, ShopSettings
from core.money import bill_totals, rupees
from core.permissions import is_owner
from inventory.models import Location, StockMovement
from inventory.services import change_stock, sale_location

from .models import Booking, BookingLine, Customer, HeldBill, Invoice, InvoiceLine, Payment, PaymentMode
from .numbering import next_number

MAX_QTY = 100_000
MAX_HELD_PER_COUNTER = 3
_PHONE = re.compile(r"^[6-9]\d{9}$")


def clean_phone(phone) -> str:
    digits = re.sub(r"\D", "", str(phone or ""))
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return digits


def validate_phone(phone, required: bool = False) -> str:
    digits = clean_phone(phone)
    if not digits:
        if required:
            raise BusinessError("Enter the customer's phone number.")
        return ""
    if not _PHONE.match(digits):
        raise BusinessError("Phone number should be 10 digits.")
    return digits


@dataclass
class PricedLine:
    product: Product
    sale_unit: str
    qty: int
    factor: int
    unit_price_paise: int
    amount_paise: int
    group_label: str

    @property
    def base_qty(self) -> int:
        return self.qty * self.factor

    @property
    def unit_label(self) -> str:
        return "Bundle" if self.sale_unit == "case" else self.product.unit_name


def load_products(ids) -> dict[int, Product]:
    return (
        Product.objects.select_related("category")
        .prefetch_related("box_items__component")
        .in_bulk(list({int(i) for i in ids}))
    )


def price_lines(raw_lines, products: dict[int, Product]) -> list[PricedLine]:
    if not raw_lines:
        raise BusinessError("Add at least one item.")
    priced = []
    for raw in raw_lines:
        try:
            product_id, qty = int(raw["product_id"]), int(raw["qty"])
        except (KeyError, TypeError, ValueError):
            raise BusinessError("An item on this bill is incomplete.")
        product = products.get(product_id)
        if product is None or not product.is_active:
            raise BusinessError(
                "An item on this bill is no longer sold. Remove it and add it again.",
                code="product_unavailable",
                product_id=product_id,
            )
        sale_unit = raw.get("sale_unit") or "unit"
        if sale_unit not in ("unit", "case"):
            raise BusinessError("Unknown unit.")
        if sale_unit == "case" and not product.units_per_case:
            raise BusinessError(f"{product.name} is not sold as a bundle.")
        if qty <= 0 or qty > MAX_QTY:
            raise BusinessError(f"Check the quantity for {product.name}.")
        factor = product.units_per_case if sale_unit == "case" else 1
        unit_price = product.price_paise * factor
        priced.append(
            PricedLine(
                product=product,
                sale_unit=sale_unit,
                qty=qty,
                factor=factor,
                unit_price_paise=unit_price,
                amount_paise=unit_price * qty,
                group_label=str(raw.get("group_label") or "").strip()[:40],
            )
        )
    return priced


def stock_needed(lines: list[PricedLine]) -> dict[int, int]:
    """Units to take out of stock. Packed-at-sale gift boxes use their items."""
    needed: dict[int, int] = defaultdict(int)
    for line in lines:
        product = line.product
        if product.deducts_components:
            items = list(product.box_items.all())
            if not items:
                raise BusinessError(
                    f"{product.name} has no items set up inside it. Ask the owner to set up this gift box.",
                    code="giftbox_empty",
                )
            for item in items:
                needed[item.component_id] += item.quantity * line.base_qty
        else:
            needed[product.pk] += line.base_qty
    return dict(needed)


def unit_cost(product: Product) -> int | None:
    if product.deducts_components:
        total = 0
        for item in product.box_items.all():
            if item.component.cost_paise is None:
                return None
            total += item.component.cost_paise * item.quantity
        return total
    return product.cost_paise


def max_discount_bp(user, settings: ShopSettings) -> int:
    if is_owner(user):
        return settings.max_discount_bp
    return min(settings.staff_max_discount_bp, settings.max_discount_bp)


def booking_advance(booking: Booking) -> int:
    return booking.payments.aggregate(total=Sum("amount_paise"))["total"] or 0


def quote(lines: list[PricedLine], discount_bp: int, doc_type: str, settings: ShopSettings) -> dict:
    gst = doc_type == Invoice.DocType.GST
    return bill_totals(
        sum(line.amount_paise for line in lines),
        discount_bp,
        gst_rate_bp=settings.gst_rate_bp if gst else None,
        prices_include_gst=settings.prices_include_gst if gst else None,
        round_off=settings.round_off,
    )


def shop_snapshot(settings: ShopSettings, doc_type: str) -> dict:
    snapshot = {
        "shop_name": settings.shop_name,
        "shop_name_tamil": settings.shop_name_tamil,
        "tagline": settings.tagline,
        "address": settings.address,
        "phones": settings.phones,
        "footer_terms": settings.footer_terms,
        "footer_thanks": settings.footer_thanks,
        "upi_id": settings.upi_id,
    }
    if doc_type == Invoice.DocType.GST:
        snapshot.update(gstin=settings.gstin, hsn_code=settings.hsn_code)
    return snapshot


def validate_payments(payments, amount_due: int) -> list[dict]:
    cleaned, modes = [], set()
    for raw in payments or []:
        mode = raw.get("mode")
        if mode not in PaymentMode.values:
            raise BusinessError("Choose how the customer paid.")
        try:
            amount = int(raw.get("amount_paise") or 0)
            tendered = raw.get("cash_tendered_paise")
            tendered = int(tendered) if tendered not in (None, "") else None
        except (TypeError, ValueError):
            raise BusinessError("Check the payment amounts.")
        if amount == 0:
            continue
        if mode in modes:
            raise BusinessError("Use each payment mode only once on a bill.")
        modes.add(mode)
        if amount_due > 0 and amount < 0:
            raise BusinessError("Payment amounts must be more than zero.")
        if amount_due < 0 and amount > 0:
            raise BusinessError("The advance is more than the bill. Record the extra as money returned.")
        if mode != PaymentMode.CASH or amount < 0:
            tendered = None
        if tendered is not None and tendered < amount:
            raise BusinessError("Cash given is less than the cash amount.")
        cleaned.append(
            {
                "mode": mode,
                "amount_paise": amount,
                "reference": str(raw.get("reference") or "").strip()[:60],
                "cash_tendered_paise": tendered,
                "change_paise": tendered - amount if tendered is not None else None,
            }
        )
    paid = sum(p["amount_paise"] for p in cleaned)
    if paid != amount_due:
        raise BusinessError(
            f"Payments add up to {rupees(paid)} but {rupees(amount_due)} is due.",
            code="payment_mismatch",
            paid_paise=paid,
            due_paise=amount_due,
        )
    return cleaned


def create_invoice(user, data: dict) -> tuple[Invoice, bool]:
    """Save a bill. Returns (invoice, created). A repeated save returns the first bill."""
    client_uuid = data["client_uuid"]
    if existing := Invoice.objects.filter(client_uuid=client_uuid).first():
        return existing, False

    doc_type = data.get("doc_type") or Invoice.DocType.ESTIMATE
    if doc_type not in Invoice.DocType.values:
        raise BusinessError("Choose Estimate or GST invoice.")
    try:
        discount_bp = int(data.get("discount_bp") or 0)
    except (TypeError, ValueError):
        raise BusinessError("Check the discount.")
    customer_name = str(data.get("customer_name") or "").strip()[:80]
    customer_phone = validate_phone(data.get("customer_phone"))

    try:
        with transaction.atomic():
            if existing := Invoice.objects.filter(client_uuid=client_uuid).first():
                return existing, False
            invoice = _create_invoice_locked(
                user, data, client_uuid, doc_type, discount_bp, customer_name, customer_phone
            )
    except IntegrityError:
        if existing := Invoice.objects.filter(client_uuid=client_uuid).first():
            return existing, False
        raise
    return invoice, True


def _create_invoice_locked(user, data, client_uuid, doc_type, discount_bp, customer_name, customer_phone) -> Invoice:
    settings = ShopSettings.get()
    if doc_type == Invoice.DocType.GST and not settings.gst_ready:
        raise BusinessError(
            "GST invoice is not set up yet (GSTIN, GST rate and whether prices include GST). "
            "Use Estimate, or ask the owner to fill these in Settings.",
            code="gst_not_ready",
        )
    counter = Counter.objects.filter(pk=data.get("counter_id"), is_active=True).first()
    if counter is None:
        raise BusinessError("Choose this device's counter first.", code="no_counter")
    limit = max_discount_bp(user, settings)
    if discount_bp < 0 or discount_bp > limit:
        raise BusinessError(f"Discount can be at most {limit / 100:g}%.", code="discount_limit")

    raw_lines = data.get("lines") or []
    products = load_products(int(line["product_id"]) for line in raw_lines if "product_id" in line)
    lines = price_lines(raw_lines, products)
    totals = quote(lines, discount_bp, doc_type, settings)

    booking, advance = None, 0
    if data.get("booking_id"):
        booking = Booking.objects.filter(pk=data["booking_id"]).first()
        if booking is None or booking.status not in (Booking.Status.BOOKED, Booking.Status.READY):
            raise BusinessError("This booking is not open any more.", code="booking_closed")
        if booking.invoices.filter(status=Invoice.Status.ACTIVE).exists():
            raise BusinessError("This booking already has a bill.", code="booking_billed")
        advance = booking_advance(booking)

    expected = data.get("expected_total_paise")
    if expected is not None and int(expected) != totals["total_paise"]:
        raise ConflictError(
            "Prices changed since this bill was started. Check the new total and save again.",
            code="price_changed",
            total_paise=totals["total_paise"],
            prices={str(p.pk): p.price_paise for p in products.values()},
        )
    payments = validate_payments(data.get("payments"), totals["total_paise"] - advance)
    location = sale_location()
    needed = stock_needed(lines)

    customer = None
    if customer_phone:
        customer, created = Customer.objects.get_or_create(phone=customer_phone, defaults={"name": customer_name})
        if not created and customer_name and not customer.name:
            customer.name = customer_name
            customer.save(update_fields=["name"])
        customer_name = customer_name or customer.name

    costs = [unit_cost(line.product) for line in lines]
    cost_total = None if any(c is None for c in costs) else sum(c * line.base_qty for c, line in zip(costs, lines))
    gst = doc_type == Invoice.DocType.GST
    number = next_number(settings.gst_prefix if gst else settings.estimate_prefix)
    today = timezone.localdate()

    invoice = Invoice.objects.create(
        client_uuid=client_uuid,
        number=number,
        doc_type=doc_type,
        counter=counter,
        counter_name=counter.name,
        user=user,
        user_name=user.display_name,
        customer=customer,
        customer_name=customer_name,
        customer_phone=customer_phone,
        booking=booking,
        subtotal_paise=totals["subtotal_paise"],
        discount_bp=discount_bp,
        discount_paise=totals["discount_paise"],
        taxable_paise=totals["taxable_paise"],
        gst_rate_bp=settings.gst_rate_bp if gst else None,
        prices_include_gst=settings.prices_include_gst if gst else None,
        cgst_paise=totals["cgst_paise"],
        sgst_paise=totals["sgst_paise"],
        round_off_paise=totals["round_off_paise"],
        total_paise=totals["total_paise"],
        advance_paise=advance,
        cost_paise=cost_total,
        shop=shop_snapshot(settings, doc_type),
        business_date=today,
    )
    InvoiceLine.objects.bulk_create(
        [
            InvoiceLine(
                invoice=invoice,
                line_no=index,
                product=line.product,
                product_code=line.product.code,
                product_name=line.product.name,
                category_name=line.product.category.name,
                sale_unit=line.sale_unit,
                unit_label=line.unit_label,
                qty=line.qty,
                units_per_sale_unit=line.factor,
                base_qty=line.base_qty,
                unit_price_paise=line.unit_price_paise,
                amount_paise=line.amount_paise,
                unit_cost_paise=cost,
                group_label=line.group_label,
            )
            for index, (line, cost) in enumerate(zip(lines, costs), start=1)
        ]
    )
    change_stock(
        items={pid: -qty for pid, qty in needed.items()},
        location=location,
        reason=StockMovement.Reason.SALE,
        user=user,
        ref_type="invoice",
        ref_id=invoice.pk,
        note=number,
    )
    Payment.objects.bulk_create(
        [
            Payment(
                invoice=invoice,
                kind=Payment.Kind.SALE if p["amount_paise"] > 0 else Payment.Kind.REFUND,
                mode=p["mode"],
                amount_paise=p["amount_paise"],
                reference=p["reference"],
                cash_tendered_paise=p["cash_tendered_paise"],
                change_paise=p["change_paise"],
                business_date=today,
                counter_name=counter.name,
                user=user,
            )
            for p in payments
        ]
    )
    if booking:
        booking.status = Booking.Status.DELIVERED
        booking.save(update_fields=["status", "updated_at"])
    if discount_bp:
        audit(
            user,
            "bill.discount",
            f"{number}: {discount_bp / 100:g}% off ({rupees(totals['discount_paise'])})",
            invoice,
            discount_bp=discount_bp,
            discount_paise=totals["discount_paise"],
        )
    return invoice


def cancel_invoice(user, invoice_id: int, reason: str) -> Invoice:
    if not is_owner(user):
        raise PermissionDenied("Only the owner can cancel a bill.")
    reason = (reason or "").strip()
    if not reason:
        raise BusinessError("Enter why this bill is being cancelled.")
    with transaction.atomic():
        invoice = Invoice.objects.filter(pk=invoice_id).first()
        if invoice is None:
            raise NotFound("Bill not found.")
        now = timezone.now()
        changed = Invoice.objects.filter(pk=invoice.pk, status=Invoice.Status.ACTIVE).update(
            status=Invoice.Status.CANCELLED, cancelled_at=now, cancelled_by=user, cancel_reason=reason[:200]
        )
        if changed != 1:
            raise BusinessError("This bill is already cancelled.", code="already_cancelled")

        returned: dict[int, dict[int, int]] = defaultdict(lambda: defaultdict(int))
        for move in StockMovement.objects.filter(
            ref_type="invoice", ref_id=str(invoice.pk), reason=StockMovement.Reason.SALE
        ):
            returned[move.location_id][move.product_id] -= move.change
        locations = Location.objects.in_bulk(list(returned))
        for location_id, items in returned.items():
            change_stock(
                items=dict(items),
                location=locations[location_id],
                reason=StockMovement.Reason.SALE_CANCEL,
                user=user,
                ref_type="invoice",
                ref_id=invoice.pk,
                note=f"Cancelled {invoice.number}",
            )

        today = timezone.localdate()
        refunds = [
            Payment(
                invoice=invoice,
                kind=Payment.Kind.REFUND,
                mode=row["mode"],
                amount_paise=-row["total"],
                reference=f"Cancelled {invoice.number}",
                business_date=today,
                counter_name=invoice.counter_name,
                user=user,
            )
            for row in invoice.payments.values("mode").annotate(total=Sum("amount_paise"))
            if row["total"]
        ]
        Payment.objects.bulk_create(refunds)
        if invoice.booking_id:
            Booking.objects.filter(pk=invoice.booking_id, status=Booking.Status.DELIVERED).update(
                status=Booking.Status.BOOKED, updated_at=now
            )
        audit(user, "bill.cancel", f"Cancelled {invoice.number}: {reason}", invoice, total_paise=invoice.total_paise)
    invoice.refresh_from_db()
    return invoice


def mark_printed(invoice_id: int) -> int:
    """Count a print. The first print is the original; later ones are duplicates."""
    with transaction.atomic():
        if Invoice.objects.filter(pk=invoice_id).update(print_count=F("print_count") + 1) != 1:
            raise NotFound("Bill not found.")
        return Invoice.objects.values_list("print_count", flat=True).get(pk=invoice_id)


# Bookings ----------------------------------------------------------------


def _counter_name(counter_id) -> str:
    counter = Counter.objects.filter(pk=counter_id).first() if counter_id else None
    return counter.name if counter else ""


def _add_advance(user, booking, mode, amount_paise, reference, counter_name) -> Payment:
    if mode not in PaymentMode.values:
        raise BusinessError("Choose how the advance was paid.")
    if amount_paise <= 0:
        raise BusinessError("Advance must be more than zero.")
    return Payment.objects.create(
        booking=booking,
        kind=Payment.Kind.ADVANCE,
        mode=mode,
        amount_paise=amount_paise,
        reference=(reference or "").strip()[:60],
        business_date=timezone.localdate(),
        counter_name=counter_name,
        user=user,
    )


def create_booking(user, data: dict) -> Booking:
    name = str(data.get("customer_name") or "").strip()[:80]
    if not name:
        raise BusinessError("Enter the customer's name.")
    phone = validate_phone(data.get("customer_phone"), required=True)
    delivery_date = data.get("delivery_date")
    if not delivery_date:
        raise BusinessError("Choose the delivery date.")
    raw_lines = data.get("lines") or []
    advance = data.get("advance") or {}

    with transaction.atomic():
        settings = ShopSettings.get()
        lines = price_lines(raw_lines, load_products(line.get("product_id") for line in raw_lines))
        booking = Booking.objects.create(
            number=next_number(settings.booking_prefix),
            customer_name=name,
            customer_phone=phone,
            address=str(data.get("address") or "").strip()[:500],
            delivery_date=delivery_date,
            note=str(data.get("note") or "").strip()[:200],
            estimate_paise=sum(line.amount_paise for line in lines),
            user=user,
        )
        BookingLine.objects.bulk_create(
            [BookingLine(booking=booking, product=l.product, sale_unit=l.sale_unit, qty=l.qty) for l in lines]
        )
        amount = int(advance.get("amount_paise") or 0)
        if amount:
            _add_advance(
                user,
                booking,
                advance.get("mode"),
                amount,
                advance.get("reference"),
                _counter_name(data.get("counter_id")),
            )
        audit(user, "booking.create", f"Booking {booking.number} for {name}", booking)
    return booking


def update_booking(user, booking_id: int, data: dict) -> Booking:
    with transaction.atomic():
        booking = Booking.objects.filter(pk=booking_id).first()
        if booking is None:
            raise NotFound("Booking not found.")
        if booking.status not in (Booking.Status.BOOKED, Booking.Status.READY):
            raise BusinessError("This booking is closed and cannot be changed.")
        if "customer_name" in data:
            name = str(data["customer_name"] or "").strip()[:80]
            if not name:
                raise BusinessError("Enter the customer's name.")
            booking.customer_name = name
        if "customer_phone" in data:
            booking.customer_phone = validate_phone(data["customer_phone"], required=True)
        if "address" in data:
            booking.address = str(data["address"] or "").strip()[:500]
        if "note" in data:
            booking.note = str(data["note"] or "").strip()[:200]
        if data.get("delivery_date"):
            booking.delivery_date = data["delivery_date"]
        if "status" in data:
            if data["status"] not in (Booking.Status.BOOKED, Booking.Status.READY):
                raise BusinessError("Status can be Booked or Ready here.")
            booking.status = data["status"]
        if "lines" in data:
            lines = price_lines(data["lines"], load_products(line.get("product_id") for line in data["lines"]))
            booking.lines.all().delete()
            BookingLine.objects.bulk_create(
                [BookingLine(booking=booking, product=l.product, sale_unit=l.sale_unit, qty=l.qty) for l in lines]
            )
            booking.estimate_paise = sum(line.amount_paise for line in lines)
        booking.save()
        audit(user, "booking.update", f"Updated booking {booking.number}", booking)
        if data.get("advance"):
            booking.advance_note = change_advance(
                user, booking, data["advance"], _counter_name(data.get("counter_id"))
            )
    return booking


def change_advance(user, booking: Booking, change: dict, counter_name: str = "") -> str | None:
    """Set the booking's total advance to a new amount (anyone may do this).

    A single advance taken on a day that is not closed yet is corrected where it is,
    for example a typing mistake. Otherwise the difference is recorded today (more
    advance, or money returned), so days that are already closed never change.
    Returns a sentence for the person when the difference was recorded today.
    """
    from cash.models import DaySession

    mode = change.get("mode")
    if mode not in PaymentMode.values:
        raise BusinessError("Choose how the advance was paid.")
    try:
        amount = int(change.get("amount_paise"))
    except (TypeError, ValueError):
        raise BusinessError("Check the advance amount.")
    if amount < 0:
        raise BusinessError("The advance cannot be less than zero.")

    payments = list(booking.payments.order_by("id"))
    current = sum(p.amount_paise for p in payments)
    advances = [p for p in payments if p.kind == Payment.Kind.ADVANCE]
    single = payments[0] if len(payments) == 1 and advances else None
    if amount == current and mode == (advances[-1].mode if advances else mode):
        return None
    day_open = single is not None and not DaySession.objects.filter(
        business_date=single.business_date, closed_at__isnull=False
    ).exists()
    summary = f"Advance for {booking.number} changed from {rupees(current)} to {rupees(amount)}"

    if day_open:
        old_mode = single.get_mode_display()
        if amount:
            single.amount_paise, single.mode = amount, mode
            single.save(update_fields=["amount_paise", "mode"])
        else:
            single.delete()
        audit(user, "booking.advance_change", f"{summary} (was {old_mode})", booking, how="corrected")
        return None

    difference = amount - current
    if not difference:
        raise BusinessError("How an earlier advance was paid can't be changed now. Only the amount can.")
    Payment.objects.create(
        booking=booking,
        kind=Payment.Kind.ADVANCE if difference > 0 else Payment.Kind.REFUND,
        mode=mode,
        amount_paise=difference,
        reference=f"Advance changed from {rupees(current)} to {rupees(amount)}"[:60],
        business_date=timezone.localdate(),
        counter_name=counter_name,
        user=user,
    )
    audit(user, "booking.advance_change", f"{summary} (difference recorded today)", booking, how="difference")
    paid = PaymentMode(mode).label
    if difference > 0:
        return f"The extra {rupees(difference)} is recorded today as paid by {paid}."
    return f"{rupees(-difference)} is recorded today as returned to the customer by {paid}."


def add_booking_payment(user, booking_id: int, data: dict) -> Payment:
    with transaction.atomic():
        booking = Booking.objects.filter(pk=booking_id).first()
        if booking is None:
            raise NotFound("Booking not found.")
        if booking.status not in (Booking.Status.BOOKED, Booking.Status.READY):
            raise BusinessError("This booking is closed.")
        try:
            amount = int(data.get("amount_paise") or 0)
        except (TypeError, ValueError):
            raise BusinessError("Check the amount.")
        payment = _add_advance(
            user, booking, data.get("mode"), amount, data.get("reference"), _counter_name(data.get("counter_id"))
        )
        audit(user, "booking.advance", f"Advance {rupees(amount)} for {booking.number}", booking)
    return payment


def cancel_booking(user, booking_id: int, reason: str, refund_mode: str | None) -> Booking:
    if not is_owner(user):
        raise PermissionDenied("Only the owner can cancel a booking.")
    reason = (reason or "").strip()
    if not reason:
        raise BusinessError("Enter why the booking is cancelled.")
    with transaction.atomic():
        booking = Booking.objects.filter(pk=booking_id).first()
        if booking is None:
            raise NotFound("Booking not found.")
        if booking.status not in (Booking.Status.BOOKED, Booking.Status.READY):
            raise BusinessError("This booking is already closed.")
        paid = booking_advance(booking)
        if paid > 0:
            if refund_mode not in PaymentMode.values:
                raise BusinessError("Choose how the advance is returned to the customer.")
            Payment.objects.create(
                booking=booking,
                kind=Payment.Kind.REFUND,
                mode=refund_mode,
                amount_paise=-paid,
                reference=f"Booking {booking.number} cancelled",
                business_date=timezone.localdate(),
                user=user,
            )
        booking.status = Booking.Status.CANCELLED
        booking.cancelled_reason = reason[:200]
        booking.save(update_fields=["status", "cancelled_reason", "updated_at"])
        audit(user, "booking.cancel", f"Cancelled booking {booking.number}: {reason}", booking, refunded_paise=paid)
    return booking


# Held bills ----------------------------------------------------------------


def hold_bill(user, counter_id, label: str, payload: dict, total_paise: int) -> HeldBill:
    if not isinstance(payload, dict) or not isinstance(payload.get("lines"), list) or not payload["lines"]:
        raise BusinessError("There is nothing on this bill to hold.")
    if len(str(payload)) > 50_000:
        raise BusinessError("This bill is too large to hold.")
    with transaction.atomic():
        counter = Counter.objects.filter(pk=counter_id, is_active=True).first()
        if counter is None:
            raise BusinessError("Choose this device's counter first.", code="no_counter")
        if HeldBill.objects.filter(counter=counter).count() >= MAX_HELD_PER_COUNTER:
            raise BusinessError(
                f"Only {MAX_HELD_PER_COUNTER} bills can be on hold at {counter.name}. Resume or remove one first.",
                code="hold_limit",
            )
        return HeldBill.objects.create(
            counter=counter,
            user=user,
            label=(label or "").strip()[:60],
            payload=payload,
            total_paise=max(int(total_paise or 0), 0),
        )

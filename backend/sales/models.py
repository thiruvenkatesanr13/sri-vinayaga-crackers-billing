from django.conf import settings
from django.db import models
from django.db.models import Q

from catalog.models import Product
from core.models import Counter


class PaymentMode(models.TextChoices):
    CASH = "cash", "Cash"
    UPI = "upi", "UPI"
    CARD = "card", "Card"
    CREDIT_CARD = "credit_card", "Credit card"
    BANK = "bank", "Bank transfer"


class Customer(models.Model):
    class Kind(models.TextChoices):
        WALK_IN = "walk_in", "Walk-in"
        REGULAR = "regular", "Regular"
        DEALER = "dealer", "Dealer"

    name = models.CharField(max_length=80, blank=True)
    phone = models.CharField(max_length=15, blank=True)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.WALK_IN)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name", "phone"]
        constraints = [
            models.UniqueConstraint(fields=["phone"], condition=~Q(phone=""), name="customer_phone_unique"),
        ]


class NumberSequence(models.Model):
    """Next number for a bill / booking prefix. Only changed inside a write lock."""

    key = models.CharField(max_length=40, unique=True)
    next_value = models.PositiveBigIntegerField(default=1)


class Booking(models.Model):
    class Status(models.TextChoices):
        BOOKED = "booked", "Booked"
        READY = "ready", "Ready"
        DELIVERED = "delivered", "Delivered"
        CANCELLED = "cancelled", "Cancelled"

    number = models.CharField(max_length=30, unique=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.BOOKED)
    customer_name = models.CharField(max_length=80)
    customer_phone = models.CharField(max_length=15)
    address = models.TextField(blank=True)
    delivery_date = models.DateField()
    note = models.CharField(max_length=200, blank=True)
    estimate_paise = models.PositiveBigIntegerField(default=0)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    cancelled_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ["delivery_date", "id"]


class BookingLine(models.Model):
    booking = models.ForeignKey(Booking, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    sale_unit = models.CharField(max_length=5, default="unit")
    qty = models.PositiveIntegerField()

    class Meta:
        ordering = ["id"]


class Invoice(models.Model):
    class DocType(models.TextChoices):
        ESTIMATE = "estimate", "Estimate"
        GST = "gst", "GST invoice"

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        CANCELLED = "cancelled", "Cancelled"

    # Sent by the browser; a retried save with the same id returns the same bill.
    client_uuid = models.UUIDField(unique=True)
    number = models.CharField(max_length=30, unique=True)
    doc_type = models.CharField(max_length=10, choices=DocType.choices)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.ACTIVE)

    counter = models.ForeignKey(Counter, null=True, on_delete=models.SET_NULL)
    counter_name = models.CharField(max_length=40)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="invoices")
    user_name = models.CharField(max_length=60)

    customer = models.ForeignKey(Customer, null=True, blank=True, on_delete=models.SET_NULL)
    customer_name = models.CharField(max_length=80, blank=True)
    customer_phone = models.CharField(max_length=15, blank=True)

    booking = models.ForeignKey(Booking, null=True, blank=True, on_delete=models.PROTECT, related_name="invoices")

    subtotal_paise = models.PositiveBigIntegerField()
    discount_bp = models.PositiveIntegerField(default=0)
    discount_paise = models.PositiveBigIntegerField(default=0)
    taxable_paise = models.PositiveBigIntegerField()
    gst_rate_bp = models.PositiveIntegerField(null=True, blank=True)
    prices_include_gst = models.BooleanField(null=True, blank=True)
    cgst_paise = models.PositiveBigIntegerField(default=0)
    sgst_paise = models.PositiveBigIntegerField(default=0)
    round_off_paise = models.BigIntegerField(default=0)
    total_paise = models.PositiveBigIntegerField()
    advance_paise = models.BigIntegerField(default=0)
    # Purchase cost of the goods sold; null when any item's cost is unknown.
    cost_paise = models.PositiveBigIntegerField(null=True, blank=True)

    # Shop details as printed on this bill (later settings changes do not alter it).
    shop = models.JSONField(default=dict)

    business_date = models.DateField(db_index=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    print_count = models.PositiveIntegerField(default=0)

    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancelled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    cancel_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["booking"],
                condition=Q(status="active") & Q(booking__isnull=False),
                name="one_active_bill_per_booking",
            ),
        ]

    @property
    def amount_due_paise(self) -> int:
        return self.total_paise - self.advance_paise


class InvoiceLine(models.Model):
    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveIntegerField()
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    product_code = models.CharField(max_length=20)
    product_name = models.CharField(max_length=120)
    category_name = models.CharField(max_length=60)
    sale_unit = models.CharField(max_length=5)
    unit_label = models.CharField(max_length=20)
    qty = models.PositiveIntegerField()
    units_per_sale_unit = models.PositiveIntegerField()
    base_qty = models.PositiveBigIntegerField()
    unit_price_paise = models.PositiveBigIntegerField()
    amount_paise = models.PositiveBigIntegerField()
    unit_cost_paise = models.PositiveBigIntegerField(null=True, blank=True)
    group_label = models.CharField(max_length=40, blank=True)

    class Meta:
        ordering = ["line_no"]


class Payment(models.Model):
    """Money in (+) or out (-). Belongs to a bill or a booking advance."""

    class Kind(models.TextChoices):
        SALE = "sale", "Bill payment"
        ADVANCE = "advance", "Booking advance"
        REFUND = "refund", "Refund"

    invoice = models.ForeignKey(Invoice, null=True, blank=True, on_delete=models.PROTECT, related_name="payments")
    booking = models.ForeignKey(Booking, null=True, blank=True, on_delete=models.PROTECT, related_name="payments")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    mode = models.CharField(max_length=12, choices=PaymentMode.choices)
    amount_paise = models.BigIntegerField()
    reference = models.CharField(max_length=60, blank=True)
    cash_tendered_paise = models.PositiveBigIntegerField(null=True, blank=True)
    change_paise = models.PositiveBigIntegerField(null=True, blank=True)
    business_date = models.DateField(db_index=True)
    counter_name = models.CharField(max_length=40, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["id"]
        constraints = [
            models.CheckConstraint(
                condition=(Q(invoice__isnull=False) & Q(booking__isnull=True))
                | (Q(invoice__isnull=True) & Q(booking__isnull=False)),
                name="payment_for_bill_or_booking",
            ),
            models.CheckConstraint(condition=~Q(amount_paise=0), name="payment_not_zero"),
        ]


class HeldBill(models.Model):
    """A bill put on hold at a counter (saved on the server, survives refresh)."""

    counter = models.ForeignKey(Counter, on_delete=models.CASCADE, related_name="held_bills")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    label = models.CharField(max_length=60, blank=True)
    payload = models.JSONField()
    total_paise = models.PositiveBigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]

from django.conf import settings
from django.db import models
from django.db.models import Q

from catalog.models import Product


class Location(models.Model):
    class Kind(models.TextChoices):
        SHOP = "shop", "Shop"
        GODOWN = "godown", "Godown"

    name = models.CharField(max_length=60, unique=True)
    kind = models.CharField(max_length=10, choices=Kind.choices)
    is_active = models.BooleanField(default=True)
    # Bills reduce stock from this location.
    is_sale_location = models.BooleanField(default=False)

    class Meta:
        ordering = ["-is_sale_location", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["is_sale_location"], condition=Q(is_sale_location=True), name="one_sale_location"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class StockBalance(models.Model):
    """Current quantity of a product at a location, in the product's unit.

    The database refuses negative quantities, so stock can never be oversold
    even when several counters save at the same moment.
    """

    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="balances")
    location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="balances")
    quantity = models.BigIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["product", "location"], name="stock_balance_unique"),
            models.CheckConstraint(condition=Q(quantity__gte=0), name="stock_never_negative"),
        ]


class StockMovement(models.Model):
    """Permanent history of every stock change. Never edited or deleted."""

    class Reason(models.TextChoices):
        OPENING = "opening", "Opening stock"
        SALE = "sale", "Sale"
        SALE_CANCEL = "sale_cancel", "Bill cancelled"
        PURCHASE = "purchase", "Purchase"
        TRANSFER_OUT = "transfer_out", "Moved out"
        TRANSFER_IN = "transfer_in", "Moved in"
        SHEET_ADD = "sheet_add", "Added in stock sheet"
        SHEET_REMOVE = "sheet_remove", "Removed in stock sheet"
        COUNT = "count", "Stock check correction"
        DAMAGE = "damage", "Damaged"

    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="movements")
    location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="movements")
    change = models.BigIntegerField()
    balance_after = models.BigIntegerField()
    reason = models.CharField(max_length=20, choices=Reason.choices)
    ref_type = models.CharField(max_length=20, blank=True)
    ref_id = models.CharField(max_length=40, blank=True)
    note = models.CharField(max_length=200, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["ref_type", "ref_id"])]


class StockTransfer(models.Model):
    """Moving stock from one place to another, e.g. godown to shop."""

    from_location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="transfers_out")
    to_location = models.ForeignKey(Location, on_delete=models.PROTECT, related_name="transfers_in")
    note = models.CharField(max_length=200, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]


class StockTransferLine(models.Model):
    transfer = models.ForeignKey(StockTransfer, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    quantity = models.PositiveIntegerField()


class StockAdjustment(models.Model):
    """Owner's daily stock check correction or a damaged-stock entry."""

    class Kind(models.TextChoices):
        COUNT = "count", "Stock check"
        DAMAGE = "damage", "Damaged"

    kind = models.CharField(max_length=10, choices=Kind.choices)
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    location = models.ForeignKey(Location, on_delete=models.PROTECT)
    expected = models.BigIntegerField()
    counted = models.BigIntegerField()
    difference = models.BigIntegerField()
    note = models.CharField(max_length=200, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]


class Supplier(models.Model):
    name = models.CharField(max_length=100, unique=True)
    phone = models.CharField(max_length=20, blank=True)
    gstin = models.CharField(max_length=15, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]


class Purchase(models.Model):
    supplier = models.ForeignKey(Supplier, null=True, blank=True, on_delete=models.PROTECT)
    bill_number = models.CharField(max_length=40, blank=True)
    bill_date = models.DateField()
    location = models.ForeignKey(Location, on_delete=models.PROTECT)
    transport_paise = models.PositiveBigIntegerField(default=0)
    goods_paise = models.PositiveBigIntegerField(default=0)
    note = models.CharField(max_length=200, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]


class PurchaseLine(models.Model):
    purchase = models.ForeignKey(Purchase, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    quantity = models.PositiveIntegerField()
    unit_cost_paise = models.PositiveBigIntegerField()
    # Unit cost including this line's share of transport charges.
    landed_unit_cost_paise = models.PositiveBigIntegerField()

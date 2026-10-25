from django.conf import settings
from django.db import models
from django.db.models import F, Q


class Category(models.Model):
    name = models.CharField(max_length=60, unique=True)
    # Short code used to generate product codes, e.g. "SP" -> SP-001.
    code = models.CharField(max_length=4, unique=True)
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "name"]
        verbose_name_plural = "categories"

    def __str__(self) -> str:
        return self.name


class Product(models.Model):
    class GiftBoxMode(models.TextChoices):
        OWN = "own", "Pre-packed (own stock)"
        COMPONENTS = "components", "Packed at sale (reduce items inside)"

    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=120)
    category = models.ForeignKey(Category, on_delete=models.PROTECT, related_name="products")
    brand = models.CharField(max_length=60, blank=True)
    # Stock is always counted in this unit (e.g. Box). Cases are converted.
    unit_name = models.CharField(max_length=20, default="Box")
    units_per_case = models.PositiveIntegerField(null=True, blank=True)
    price_paise = models.PositiveBigIntegerField()
    # Purchase cost per unit, visible to the owner only. Null = not known yet.
    cost_paise = models.PositiveBigIntegerField(null=True, blank=True)
    low_stock_level = models.PositiveIntegerField(null=True, blank=True)
    photo = models.ImageField(upload_to="products/", blank=True)
    is_active = models.BooleanField(default=True)
    is_gift_box = models.BooleanField(default=False)
    gift_box_mode = models.CharField(max_length=12, choices=GiftBoxMode.choices, default=GiftBoxMode.OWN)
    source_row = models.PositiveIntegerField(null=True, blank=True)
    # What the stock sheet said at this item's last import: Qty Add, QTY Removed, price and bundle size.
    # The next import does not use an amount again while the sheet still shows the same number.
    import_last = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["category__sort_order", "code"]
        constraints = [
            models.CheckConstraint(
                condition=Q(units_per_case__isnull=True) | Q(units_per_case__gte=2),
                name="product_units_per_case_at_least_2",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} {self.name}"

    @property
    def case_price_paise(self) -> int | None:
        return self.price_paise * self.units_per_case if self.units_per_case else None

    @property
    def deducts_components(self) -> bool:
        return self.is_gift_box and self.gift_box_mode == self.GiftBoxMode.COMPONENTS


class GiftBoxItem(models.Model):
    """One item packed inside a gift box, with how many units of it."""

    gift_box = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="box_items")
    component = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="used_in_boxes")
    quantity = models.PositiveIntegerField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["gift_box", "component"], name="giftbox_component_unique"),
            models.CheckConstraint(condition=~Q(gift_box=F("component")), name="giftbox_not_itself"),
            models.CheckConstraint(condition=Q(quantity__gte=1), name="giftbox_quantity_positive"),
        ]


class ImportBatch(models.Model):
    """A confirmed import of the stock sheet. Importing the same sheet again changes nothing."""

    file_name = models.CharField(max_length=200)
    file_sha256 = models.CharField(max_length=64, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    products_created = models.PositiveIntegerField(default=0)
    products_skipped = models.PositiveIntegerField(default=0)
    stock_location_name = models.CharField(max_length=60, blank=True)
    summary = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]

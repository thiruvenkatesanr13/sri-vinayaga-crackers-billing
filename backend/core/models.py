from django.contrib.auth.models import AbstractUser
from django.db import models
from django.db.models.functions import Lower


class User(AbstractUser):
    """Shop user. Logs in with a PIN, stored hashed in the password field."""

    class Role(models.TextChoices):
        OWNER = "owner", "Owner"
        STAFF = "staff", "Staff"

    display_name = models.CharField(max_length=60)
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.STAFF)
    failed_pin_attempts = models.PositiveSmallIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(Lower("display_name"), name="user_display_name_unique_ci"),
        ]

    @property
    def is_owner(self) -> bool:
        return self.role == self.Role.OWNER

    def __str__(self) -> str:
        return self.display_name


class ShopSettings(models.Model):
    """Single row (pk=1) holding the shop, bill and backup settings."""

    shop_name = models.CharField(max_length=80, default="Sri Vinayaga Crackers")
    shop_name_tamil = models.CharField(max_length=80, blank=True, default="ஸ்ரீ விநாயகா கிராக்கர்ஸ்")
    tagline = models.CharField(max_length=80, blank=True, default="Sivakasi Crackers")
    address = models.TextField(blank=True)
    phones = models.CharField(max_length=80, blank=True, default="9087289583 / 9994925476")
    gstin = models.CharField(max_length=15, blank=True)
    bank_details = models.TextField(blank=True)
    upi_id = models.CharField(max_length=80, blank=True)
    footer_terms = models.CharField(max_length=160, blank=True, default="Goods once sold will not be taken back")
    footer_thanks = models.CharField(max_length=160, blank=True, default="Thank you. Happy Diwali!")

    estimate_prefix = models.CharField(max_length=20, default="E-")
    gst_prefix = models.CharField(max_length=20, default="G-")
    booking_prefix = models.CharField(max_length=20, default="B-")

    round_off = models.BooleanField(default=True)
    # Whole-bill discount already applied on a new bill, in basis points (5000 = 50%). Billers can change it on any bill.
    default_discount_bp = models.PositiveIntegerField(default=5000)

    # GST invoices stay disabled until the owner's CA confirms these.
    gst_rate_bp = models.PositiveIntegerField(null=True, blank=True)
    hsn_code = models.CharField(max_length=12, blank=True)
    prices_include_gst = models.BooleanField(null=True, blank=True)

    low_stock_default = models.PositiveIntegerField(null=True, blank=True)

    # A Google Drive for Desktop folder, e.g. "G:\My Drive\Sri Vinayaga Backups".
    backup_folder = models.CharField(max_length=400, blank=True)

    owner_whatsapp = models.CharField(max_length=15, blank=True)

    # Licence gate (see core/license.py). license_key holds a signed renewal key from the admin;
    # license_last_seen is the latest day the app ran, so the clock cannot be turned back past it.
    license_key = models.TextField(blank=True, default="")
    license_last_seen = models.DateField(null=True, blank=True)

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = "shop settings"

    @classmethod
    def get(cls) -> "ShopSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    @property
    def gst_ready(self) -> bool:
        return bool(self.gst_rate_bp) and self.prices_include_gst is not None and bool(self.gstin)


class Counter(models.Model):
    name = models.CharField(max_length=40, unique=True)
    is_active = models.BooleanField(default=True)
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "id"]

    def __str__(self) -> str:
        return self.name


class AuditLog(models.Model):
    """Who did what: cancellations, discounts, price and stock changes, settings."""

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    user = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL)
    user_name = models.CharField(max_length=60, blank=True)
    action = models.CharField(max_length=60, db_index=True)
    object_type = models.CharField(max_length=40, blank=True)
    object_id = models.CharField(max_length=40, blank=True)
    summary = models.CharField(max_length=300, blank=True)
    details = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]

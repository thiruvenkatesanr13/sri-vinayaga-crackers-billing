from django.conf import settings
from django.db import models


class Expense(models.Model):
    class Category(models.TextChoices):
        ELECTRICITY = "electricity", "Electricity"
        TEA = "tea", "Tea"
        LABOUR = "labour", "Labour"
        FOOD = "food", "Food"
        TRANSPORT = "transport", "Transport"
        OTHER = "other", "Other"

    business_date = models.DateField(db_index=True)
    category = models.CharField(max_length=12, choices=Category.choices)
    amount_paise = models.PositiveBigIntegerField()
    note = models.CharField(max_length=200, blank=True)
    # Paid from the cash drawer (reduces expected cash at day closing).
    paid_from_drawer = models.BooleanField(default=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]


class DaySession(models.Model):
    """Opening cash in the morning and the counted cash at day closing."""

    business_date = models.DateField(unique=True)
    opening_cash_paise = models.PositiveBigIntegerField()
    opened_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    opened_at = models.DateTimeField(auto_now_add=True)

    closed_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    expected_cash_paise = models.BigIntegerField(null=True, blank=True)
    counted_cash_paise = models.PositiveBigIntegerField(null=True, blank=True)
    difference_paise = models.BigIntegerField(null=True, blank=True)
    handed_over_paise = models.PositiveBigIntegerField(null=True, blank=True)
    note = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ["-business_date"]

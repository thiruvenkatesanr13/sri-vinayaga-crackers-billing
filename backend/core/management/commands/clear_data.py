"""Fresh start: delete products, stock, bills and the shop's other records. People, PINs and settings stay."""

from django.core.files.storage import default_storage
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from backups.services import data_dir, db_path, local_backup_dir, snapshot_database
from cash.models import DaySession, Expense
from catalog.importer import ensure_default_categories
from catalog.models import Category, GiftBoxItem, ImportBatch, Product
from core.audit import audit
from core.models import AuditLog, Counter, ShopSettings, User
from inventory.models import (
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
from sales.models import Booking, BookingLine, Customer, HeldBill, Invoice, InvoiceLine, NumberSequence, Payment

# Deleted in this order: every row goes before the rows it points to, so no protected link is left behind.
CLEARED = [
    Payment, InvoiceLine, Invoice, BookingLine, Booking, HeldBill, Customer, NumberSequence,
    Expense, DaySession,
    StockMovement, StockBalance, StockTransferLine, StockTransfer, StockAdjustment, PurchaseLine, Purchase, Supplier,
    GiftBoxItem, Product, Category, ImportBatch,
]
KEPT = [User, ShopSettings, Counter, Location, AuditLog]


def count(n: int) -> str:
    """1234567 -> 12,34,567 (Indian grouping)."""
    digits = str(n)
    if len(digits) <= 3:
        return digits
    head, groups = digits[:-3], [digits[-3:]]
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    return ",".join([head] + groups if head else groups)


class Command(BaseCommand):
    help = "Delete products, stock, bills and the other shop records for a fresh start. People, PINs and settings stay."

    def add_arguments(self, parser):
        parser.add_argument("--yes", action="store_true", help="Do not ask for confirmation")

    def handle(self, *args, **options):
        found = {
            "products": Product.objects.count(),
            "stock": StockBalance.objects.aggregate(total=Sum("quantity"))["total"] or 0,
            "bills": Invoice.objects.count(),
            "bookings": Booking.objects.count(),
            "customers": Customer.objects.count(),
            "purchases": Purchase.objects.count(),
            "suppliers": Supplier.objects.count(),
            "transfers": StockTransfer.objects.count(),
            "stock_checks": StockAdjustment.objects.count(),
            "expenses": Expense.objects.count(),
            "days": DaySession.objects.count(),
        }
        self.stdout.write("This deletes, on this PC:")
        for label, text in (
            ("Products and stock", f"{count(found['products'])} products, {count(found['stock'])} in stock"),
            ("Bills", count(found["bills"])),
            ("Bookings", count(found["bookings"])),
            ("Customers", count(found["customers"])),
            ("Purchases", f"{count(found['purchases'])}, from {count(found['suppliers'])} suppliers"),
            ("Stock moves", f"{count(found['transfers'])} between places, {count(found['stock_checks'])} stock checks"),
            ("Expenses", count(found["expenses"])),
            ("Day closings", count(found["days"])),
        ):
            self.stdout.write(f"  {label:<20}{text}")
        self.stdout.write("It keeps people and PINs, shop settings, counters, the stock places, backups and the activity log.")
        self.stdout.write("Bill and booking numbers start again from 1.")
        self.stdout.write("")
        if not options["yes"]:
            answer = input("Type YES to delete all of this: ")
            if answer.strip() != "YES":
                raise CommandError("Nothing was deleted.")

        local_backup_dir().mkdir(parents=True, exist_ok=True)
        safety = local_backup_dir() / f"before-clear-{timezone.localtime():%Y%m%d-%H%M%S}.sqlite3"
        snapshot_database(db_path(), safety)
        self.stdout.write(f"Current data saved first as {safety.name}")

        photos = list(Product.objects.exclude(photo="").values_list("photo", flat=True))
        with transaction.atomic():
            for model in CLEARED:
                model.objects.all().delete()
            ensure_default_categories()
            audit(None, "data.clear", "Deleted products, stock, bills and other records for a fresh start", **found)

        # Files that belonged to the deleted records: product photos and the uploaded stock sheets.
        for name in photos:
            default_storage.delete(name)
        for sheet in (data_dir() / "imports").glob("*.xlsx"):
            sheet.unlink(missing_ok=True)

        self.stdout.write(self.style.SUCCESS("Done. Everything above is deleted."))
        self.stdout.write("Next: open Products and use Import from Excel to load the stock sheet.")
        self.stdout.write("If billing is open on the counters, press F5 there to see the change.")
        self.stdout.write(
            f"To undo: close the billing server window, then drag {safety.name} "
            "(in data\\backups) onto scripts\\restore_backup.bat."
        )

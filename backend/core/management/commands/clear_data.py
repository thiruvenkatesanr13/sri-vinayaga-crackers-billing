"""Full fresh start: delete everything in the shop's database, as on a new laptop.

People and PINs, shop settings, counters, stock places, products, stock, bills and every other record
go, and billing shows the first-time Set up screen again. Backups are not touched, and the data is
saved first as data/backups/before-clear-<date>.sqlite3, so it can be put back.
"""

from pathlib import Path

from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from backups.services import data_dir, db_path, local_backup_dir, snapshot_database
from cash.models import DaySession, Expense
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
    AuditLog, Session, Counter, Location, ShopSettings, User,
]


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


def names(values: list[str], most: int = 6) -> str:
    shown = ", ".join(values[:most])
    return f"{shown}, ..." if len(values) > most else shown


def delete_files(folder: Path) -> None:
    if folder.is_dir():
        for item in folder.rglob("*"):
            if item.is_file():
                item.unlink(missing_ok=True)


class Command(BaseCommand):
    help = "Delete everything on this PC (people, PINs, settings, products, stock, bills...) for a fresh start."

    def add_arguments(self, parser):
        parser.add_argument("--yes", action="store_true", help="Do not ask for confirmation")

    def handle(self, *args, **options):
        people = list(User.objects.order_by("role", "display_name").values_list("display_name", flat=True))
        shop = ShopSettings.objects.filter(pk=1).first()
        places = list(Counter.objects.values_list("name", flat=True)) + list(Location.objects.values_list("name", flat=True))
        found = {
            "people": len(people),
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
            "activity": AuditLog.objects.count(),
        }
        self.stdout.write("This deletes EVERYTHING on this PC, like a new install:")
        for label, text in (
            ("People and PINs", f"{found['people']} ({names(people)})" if people else "0"),
            ("Shop settings", f"{shop.shop_name}: details, bill numbers, GST, discounts, Google Drive folder" if shop else "not set"),
            ("Counters, places", names(places) or "none"),
            ("Products and stock", f"{count(found['products'])} products, {count(found['stock'])} in stock"),
            ("Bills", count(found["bills"])),
            ("Bookings", count(found["bookings"])),
            ("Customers", count(found["customers"])),
            ("Purchases", f"{count(found['purchases'])}, from {count(found['suppliers'])} suppliers"),
            ("Stock moves", f"{count(found['transfers'])} between places, {count(found['stock_checks'])} stock checks"),
            ("Expenses", count(found["expenses"])),
            ("Day closings", count(found["days"])),
            ("Activity log", f"{count(found['activity'])} entries"),
        ):
            self.stdout.write(f"  {label:<20}{text}")
        self.stdout.write("Backups are not deleted: data\\backups and the Google Drive folder stay as they are.")
        self.stdout.write("Afterwards billing shows the first-time Set up screen, as on a new laptop.")
        self.stdout.write("")
        if not options["yes"]:
            answer = input("Type YES to delete everything: ")
            if answer.strip() != "YES":
                raise CommandError("Nothing was deleted.")

        local_backup_dir().mkdir(parents=True, exist_ok=True)
        safety = local_backup_dir() / f"before-clear-{timezone.localtime():%Y%m%d-%H%M%S}.sqlite3"
        snapshot_database(db_path(), safety)
        self.stdout.write(f"Current data saved first as {safety.name}")

        with transaction.atomic():
            for model in CLEARED:
                model.objects.all().delete()
            # The one line the new activity log starts with, so the owner can see when this happened.
            audit(None, "data.clear", "Deleted everything on this PC for a fresh start", **found)

        # Files that belonged to the deleted records: product photos and the uploaded stock sheets.
        delete_files(Path(settings.MEDIA_ROOT))
        delete_files(data_dir() / "imports")

        self.stdout.write(self.style.SUCCESS("Done. Everything above is deleted."))
        self.stdout.write("Next: press F5 in billing on every counter. The Set up this PC screen appears:")
        self.stdout.write("  create the owner and PIN, choose the counter, fill in Settings (including the")
        self.stdout.write("  Google Drive folder under Backup), add staff, then import the stock sheet on Products.")
        self.stdout.write(
            f"To undo: close the billing server window, then drag {safety.name} "
            "(in data\\backups) onto scripts\\restore_backup.bat."
        )

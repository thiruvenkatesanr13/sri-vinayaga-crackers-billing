import socket
import sqlite3
from pathlib import Path

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.utils import timezone

from backups.services import check_database, db_path, list_local_backups, local_backup_dir, snapshot_database


def server_running(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


class Command(BaseCommand):
    help = "Restore the shop's data from a backup file. Stop the billing server first."

    def add_arguments(self, parser):
        parser.add_argument("backup_file", nargs="?", help="Backup file (leave empty to choose from a list)")
        parser.add_argument("--yes", action="store_true", help="Do not ask for confirmation")
        parser.add_argument("--port", type=int, default=8000, help="Port the billing server uses")

    def handle(self, *args, **options):
        if server_running(options["port"]):
            raise CommandError("The billing server is still running. Close it first, then run the restore again.")

        path = options["backup_file"]
        if not path:
            backups = list_local_backups(15)
            if not backups:
                raise CommandError(f"No backups found in {local_backup_dir()}")
            self.stdout.write("Backups on this PC (newest first):")
            for number, item in enumerate(backups, start=1):
                self.stdout.write(f"  {number:2d}. {item['file']}  ({item['size'] // 1024} KB)")
            choice = input("Type the number to restore (or press Enter to stop): ").strip()
            if not choice.isdigit() or not 1 <= int(choice) <= len(backups):
                raise CommandError("Nothing was restored.")
            path = local_backup_dir() / backups[int(choice) - 1]["file"]
        source = Path(path)
        if source.suffix.lower() == ".xlsx":
            raise CommandError(f"{source.name} is the Excel copy. Restore the .sqlite3 file with the same name instead.")
        if not source.is_file():
            raise CommandError(f"File not found: {source}")

        try:
            check_database(source)
        except Exception as exc:  # noqa: BLE001
            raise CommandError(f"This backup cannot be used: {exc}")

        known = set(MigrationLoader(None, ignore_no_migrations=True).disk_migrations)
        conn = sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            applied = {(app, name) for app, name in conn.execute("SELECT app, name FROM django_migrations")}
            shop = conn.execute("SELECT shop_name FROM core_shopsettings WHERE id = 1").fetchone()
        finally:
            conn.close()
        ours = {key for key in known if key[0] in {"core", "catalog", "inventory", "sales", "cash"}}
        newer = {key for key in applied if key[0] in {"core", "catalog", "inventory", "sales", "cash"}} - ours
        if newer:
            raise CommandError("This backup was made by a newer version of the app. Update this PC first.")

        self.stdout.write(f"Backup: {source.name} ({shop[0] if shop else 'shop not set up yet'})")
        if not options["yes"]:
            answer = input("This replaces ALL current data on this PC with the backup. Type YES to continue: ")
            if answer.strip() != "YES":
                raise CommandError("Nothing was restored.")

        safety = local_backup_dir() / f"before-restore-{timezone.localtime():%Y%m%d-%H%M%S}.sqlite3"
        snapshot_database(db_path(), safety)
        self.stdout.write(f"Current data saved first as {safety.name}")

        connection.close()
        src = sqlite3.connect(str(source))
        try:
            dst = sqlite3.connect(str(db_path()))
            try:
                src.backup(dst)
                dst.execute("PRAGMA journal_mode=WAL")
            finally:
                dst.close()
        finally:
            src.close()
        call_command("migrate", interactive=False, verbosity=0)
        check_database(db_path())
        self.stdout.write(self.style.SUCCESS("Restore finished. Start the billing server again."))

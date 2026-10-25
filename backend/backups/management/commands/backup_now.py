from django.core.management.base import BaseCommand

from backups.services import DAY, HOURLY, create_backup


class Command(BaseCommand):
    help = "Back up the shop's data now (to this PC and the Google Drive folder, if set)."

    def add_arguments(self, parser):
        parser.add_argument("--day", action="store_true", help="Make today's Day backup instead of an Hourly one")

    def handle(self, *args, **options):
        status = create_backup("command", kind=DAY if options["day"] else HOURLY)
        self.stdout.write(self.style.SUCCESS("Backup saved on this PC:"))
        if status.get("last_local_excel"):
            self.stdout.write(f"  {status['last_local_excel']}  (open in Excel)")
        else:
            self.stdout.write(self.style.WARNING(f"  The Excel copy could not be made: {status.get('excel_error')}"))
        self.stdout.write(f"  {status['last_local_file']}  (used to restore)")
        if status.get("drive_configured"):
            if status.get("drive_error"):
                self.stdout.write(self.style.WARNING(f"Google Drive copy failed: {status['drive_error']}"))
            else:
                self.stdout.write(self.style.SUCCESS("Copied to the Google Drive folder."))
        else:
            self.stdout.write("Google Drive folder is not set, so only the PC copy was made.")

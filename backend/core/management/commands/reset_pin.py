"""Set a new PIN for someone who forgot theirs. Run on the billing laptop."""

from getpass import getpass

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.api import validate_pin
from core.audit import audit
from core.errors import BusinessError
from core.models import User


class Command(BaseCommand):
    help = "Set a new PIN for a person, for example when the owner forgets theirs."

    def add_arguments(self, parser):
        parser.add_argument("name", nargs="?", help="The person's name as shown on the login screen")

    def handle(self, *args, **options):
        people = list(User.objects.filter(is_active=True).order_by("role", "display_name"))
        if not people:
            raise CommandError("Nobody is set up on this PC yet. Open billing and finish the first-time setup.")
        name = options["name"]
        if not name:
            self.stdout.write("People on this PC:")
            for person in people:
                self.stdout.write(f"  {person.display_name} ({person.get_role_display()})")
            name = input("Type the name: ")
        user = next((p for p in people if p.display_name.lower() == name.strip().lower()), None)
        if user is None:
            raise CommandError(f"Nobody called {name.strip()!r} on this PC.")

        pin = getpass(f"New PIN for {user.display_name}: ")
        if getpass("Type the new PIN again: ") != pin:
            raise CommandError("The two PINs are different. Nothing was changed.")
        try:
            pin = validate_pin(pin, user.role)
        except BusinessError as exc:
            raise CommandError(exc.message) from exc

        with transaction.atomic():
            user.set_password(pin)
            user.failed_pin_attempts = 0
            user.locked_until = None
            user.save(update_fields=["password", "failed_pin_attempts", "locked_until"])
            audit(None, "user.pin_reset", f"PIN reset for {user.display_name} on the server PC", user)
        self.stdout.write(self.style.SUCCESS(f"New PIN saved for {user.display_name}. They can log in with it now."))

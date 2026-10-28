"""Start the billing server on the shop's billing laptop.

Runs Waitress on all network cards so the other counters can open the app
over Wi-Fi, applies any database updates, and backs up every few minutes.
"""

import logging
import os
import socket
import sys
import threading
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.utils import timezone  # noqa: E402
from waitress import serve  # noqa: E402

from config.wsgi import application  # noqa: E402

log = logging.getLogger("serve")


def lan_address() -> str | None:
    """The one address other counters should use: this PC's address on the network that leads to the shop's router.

    Virtual network cards (Hyper-V, WSL, VirtualBox, VMware) also have addresses, but other
    counters cannot reach those, so they are not shown. No packet is sent here: connecting
    a UDP socket only asks Windows which network card it would use.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 53))
            address = probe.getsockname()[0]
    except OSError:
        return None
    return None if address.startswith(("0.", "127.", "169.254.")) else address


def seconds_to_next_hour() -> float:
    now = timezone.localtime()
    following = (now + timezone.timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    return (following - now).total_seconds()


def backup_loop(stop: threading.Event) -> None:
    """Hourly backups from 7 AM to 10 PM and the Day backup at 11 PM, on the hour.

    When billing starts, a day that ended without its Day backup (laptop switched off
    before 11 PM, day not closed) gets it first.
    """
    from backups.services import DAY, HOURLY, create_backup, missed_day
    from core.models import User

    try:
        if User.objects.exists() and (day := missed_day()):
            create_backup("catch-up", kind=DAY, day=day)
    except Exception:  # noqa: BLE001 - keep billing running; the dashboard shows the last backup time
        log.exception("Catch-up Day backup failed")

    while not stop.wait(seconds_to_next_hour() + 1):
        hour = timezone.localtime().hour
        if not 7 <= hour <= 23 or not User.objects.exists():
            continue
        try:
            create_backup("auto", kind=DAY if hour == 23 else HOURLY)
        except Exception:  # noqa: BLE001 - keep billing running; the dashboard shows the last backup time
            log.exception("Automatic backup failed")


def already_running(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def main() -> None:
    # Show the startup lines at once even when the output goes to a log file.
    sys.stdout.reconfigure(line_buffering=True)
    port = int(os.environ.get("SVC_PORT", "8000"))
    if already_running(port):
        print(f"  Billing is already running on this PC. Open http://localhost:{port}")
        sys.exit(3)  # start_billing.bat stops instead of retrying
    if not settings.FRONTEND_DIST.joinpath("index.html").exists():
        print("The screens are not built. Run scripts\\build_frontend.bat first.")
    call_command("migrate", interactive=False, verbosity=0)

    from core.license import license_status
    from core.models import ShopSettings

    lic = license_status(ShopSettings.get())
    if not lic["ok"]:
        print()
        print("  * This software is not licensed to run. Contact the admin to troubleshoot.")

    stop = threading.Event()
    if settings.AUTO_BACKUP:
        threading.Thread(target=backup_loop, args=(stop,), daemon=True, name="auto-backup").start()

    address = lan_address()
    print()
    print("  Sri Vinayaga Crackers billing is running. Keep this window open.")
    print()
    print(f"  1. On this PC:      http://localhost:{port}")
    if address:
        print(f"  2. Other counters:  http://{address}:{port}")
    else:
        print("  2. Other counters:  connect this PC to the shop Wi-Fi, then start billing again")
    print()
    print(f"  Data folder: {settings.DATA_DIR}")
    print()
    try:
        serve(application, host="0.0.0.0", port=port, threads=12, channel_timeout=120, ident="svc-billing")
    finally:
        stop.set()


if __name__ == "__main__":
    main()

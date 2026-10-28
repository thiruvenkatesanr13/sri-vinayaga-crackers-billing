"""Runtime licence check for the billing app.

The app runs until a set date and then stops, showing the shop a short message to contact the
administrator. The administrator can issue a signed renewal that moves the date forward. Nothing
here deletes data, and the maintenance commands keep working, so records are never lost.
"""

import base64
import json
import os
from datetime import date
from pathlib import Path

import rsa
from django.conf import settings
from django.utils import timezone

# The app is licensed until this day (exclusive): it works through the day before and locks on it.
# 2027-02-01 => works through 31 Jan 2027, locks from 1 Feb 2027.
LICENSE_UNTIL = date(2027, 2, 1)

# The administrator's public key. A renewal is a token signed with the matching private key,
# which only the administrator holds. This file never contains the private key.
PUBLIC_KEY_PEM = b"""-----BEGIN RSA PUBLIC KEY-----
MIIBCgKCAQEA06tQZi/Yxhk/92VXdXya/vpOB12STjAG1OSPO0DpjBG0819dQ8Mp
nUbXFvzMcD1EELn1QiDU7dijpV9A7+V0R/DMxVUBNg9fLOmDK0UvDDf2A7FSqPr2
ddreC6Sbw8MUJC6hIM156XCp81DS0ynSXgNR8CdltK0Lj+H+NkGsLNYIJcTdWA0e
DVE0VoSuCbTU+/qa3hlVEVG4UrUoEwXfSs92xE86Vlm8JBYUjeedR6lTHpkoDiq8
ZQ7QbymxXe23XOh66in0oAzsiO6/IVphcEk2Hr6iowbVX7vRDUuJtp/VVFqekXiP
wtlZmOyRpcjCuiDYxGD2DMO73PeIsp2rIwIDAQAB
-----END RSA PUBLIC KEY-----"""

_pubkey = rsa.PublicKey.load_pkcs1(PUBLIC_KEY_PEM)


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_key(token: str) -> date | None:
    """The 'until' date carried by a valid renewal key, or None when it is missing or not genuine."""
    try:
        body, signature = str(token or "").strip().split(".")
        payload = _unb64(body)
        rsa.verify(payload, _unb64(signature), _pubkey)
        return date.fromisoformat(json.loads(payload)["until"])
    except Exception:  # noqa: BLE001 - any bad/forged token simply does not extend the licence
        return None


def effective_until(shop) -> date:
    """The day the app is licensed until: the built-in date, or a later one from a valid key."""
    extended = verify_key(getattr(shop, "license_key", "") or "")
    return max(LICENSE_UNTIL, extended) if extended else LICENSE_UNTIL


def _state_path() -> Path | None:
    """A small file beside the database that also holds the latest day seen, so the guard
    survives a database restore or a full data clear. Off under tests unless SVC_LIC_STATE is set."""
    override = os.environ.get("SVC_LIC_STATE")
    if override:
        return Path(override)
    try:
        if settings.TESTING:
            return None
        return Path(settings.DATA_DIR) / ".appstate"
    except Exception:  # noqa: BLE001 - the guard file must never break the app
        return None


def _read_state(path: Path) -> date | None:
    try:
        return date.fromordinal(int(path.read_text().strip()))
    except Exception:  # noqa: BLE001 - a missing or edited file simply does not count
        return None


def _write_state(path: Path, day: date) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(str(day.toordinal()))
        os.replace(temp, path)
    except Exception:  # noqa: BLE001 - a read-only disk must not stop billing
        pass


def _today(shop) -> date:
    """Today, but never earlier than the latest day the app has run (kept in the database and in a
    file beside it), so moving the clock back, restoring an old backup or clearing all data cannot
    move the licence date away."""
    day = timezone.localdate()
    seen = getattr(shop, "license_last_seen", None)
    if seen and seen > day:
        day = seen
    path = _state_path()
    if path:
        external = _read_state(path)
        if external and external > day:
            day = external
    return day


def license_ok(shop) -> bool:
    return _today(shop) < effective_until(shop)


def mark_seen(shop) -> None:
    """Record the latest day the app has run, in both the database and the file beside it, so the
    date can only ever move forward."""
    high = _today(shop)
    path = _state_path()
    if path and (_read_state(path) or date.min) < high:
        _write_state(path, high)
    if shop.license_last_seen is None or shop.license_last_seen < high:
        shop.license_last_seen = high
        shop.save(update_fields=["license_last_seen"])


def license_status(shop) -> dict:
    return {"ok": license_ok(shop), "until": effective_until(shop).isoformat()}


class LicenseMiddleware:
    """Blocks every API call after the licence ends, except the two the lock screen needs."""

    OPEN = {"/api/bootstrap", "/api/license"}

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path
        if path.startswith("/api/") and path not in self.OPEN:
            from core.models import ShopSettings

            if not license_ok(ShopSettings.get()):
                from django.http import JsonResponse

                return JsonResponse(
                    {"detail": "This software is not licensed to run. Contact the admin to troubleshoot.", "code": "license_expired"},
                    status=403,
                )
        return self.get_response(request)

"""Licence gate: the app is licensed until a date, after which it stops working and asks the
shop to contact the admin. A renewal key signed by the admin (see tools/license_sign.py) can
extend the date; it can never shorten it. Nothing here deletes data, and the management
commands (restore, clear_data, reset_pin, backup_now) keep working so data is never stuck.

To change the lock date, edit LICENSE_UNTIL below. To remove the gate entirely, delete this
file and the three lines that use it: the "core.license.LicenseMiddleware" entry in
config/settings.py MIDDLEWARE, and the license lines in core/api.py (bootstrap + license_view).
"""

import base64
import json
from datetime import date

import rsa
from django.utils import timezone

# The app is licensed until this day (exclusive): it works through the day before and locks on it.
# 2027-02-01 => works through 31 Jan 2027, locks from 1 Feb 2027.
LICENSE_UNTIL = date(2027, 2, 1)

# The admin's public key. A renewal key is a token signed with the matching private key, which
# only the admin holds (tools/license_private_key.pem, never in this repo).
PUBLIC_KEY_PEM = b"""-----BEGIN RSA PUBLIC KEY-----
MIIBCgKCAQEA0vmBiImfq0RqThfzjLz4yfbwgBPlyoE3Rp3Su1abXYgpMX2/HL3o
uJpAhugEp3/KZhLZzcQMHDFvPvib+uDN8LJLKPfUKNKVR7G1XVbrQjJ7OWvYjsqs
888j8syqskD4td/XFR4qGktnqQ59ZqsEdVRwZiFu+DAQQEYsGJGlXjPWvJARKKsW
SvG9a5/gq5QM3doXuBhK/JGzdkhIctfzZy1xbxmg9bWsz9FeCMu5h5T9hndbFKN/
6x6p1GmiZQvu7YkIA5vABA3/nwBhQxTUl0KExDFu6VdEC8b6EbM/Hc8ZPVcxXzAU
0GuXIC4jlXwVJB0L44Bji3O3b6FgZxb2TQIDAQAB
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


def _today(shop) -> date:
    """Today, but never earlier than the latest day the app has run, so turning the clock back
    cannot move the licence date away."""
    today = timezone.localdate()
    seen = getattr(shop, "license_last_seen", None)
    return max(today, seen) if seen else today


def license_ok(shop) -> bool:
    return _today(shop) < effective_until(shop)


def mark_seen(shop) -> None:
    """Remember today as the latest day the app ran (only ever moves forward)."""
    today = timezone.localdate()
    if shop.license_last_seen is None or today > shop.license_last_seen:
        shop.license_last_seen = today
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

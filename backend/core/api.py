import json
import math
import re
import uuid
from pathlib import Path

from django.conf import settings
from django.contrib.auth import login, logout, update_session_auth_hash
from django.db import transaction
from django.db.models import F
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotFound
from rest_framework.response import Response

from .audit import audit
from .errors import BusinessError
from .models import AuditLog, Counter, ShopSettings, User
from .permissions import IsOwner, OwnerWriteStaffRead, is_owner

WEAK_PINS = {"1234", "12345", "123456", "1234567", "12345678", "4321", "654321", "1212", "121212"}


def validate_pin(pin, role: str) -> str:
    pin = str(pin or "").strip()
    shortest = 6 if role == User.Role.OWNER else 4
    if not pin.isdigit() or not shortest <= len(pin) <= 8:
        raise BusinessError(f"PIN must be {shortest} to 8 digits.")
    if len(set(pin)) == 1 or pin in WEAK_PINS:
        raise BusinessError("Choose a PIN that is harder to guess.")
    return pin


def validate_name(name) -> str:
    name = re.sub(r"\s+", " ", str(name or "")).strip()
    if not 2 <= len(name) <= 60:
        raise BusinessError("Name should be 2 to 60 letters.")
    return name


def user_payload(user) -> dict:
    return {"id": user.pk, "name": user.display_name, "role": user.role, "is_owner": is_owner(user)}


def _json_body(request) -> dict:
    try:
        data = json.loads(request.body or b"{}")
    except ValueError:
        raise BusinessError("Invalid request.")
    if not isinstance(data, dict):
        raise BusinessError("Invalid request.")
    return data


def _error(exc: BusinessError) -> JsonResponse:
    return JsonResponse({"detail": exc.message, "code": exc.code, **exc.extra}, status=exc.status_code)


def bootstrap_payload(request) -> dict:
    shop = ShopSettings.objects.filter(pk=1).first()
    setup_required = not User.objects.exists()
    return {
        "setup_required": setup_required,
        "shop_name": shop.shop_name if shop else "Sri Vinayaga Crackers",
        "shop_name_tamil": shop.shop_name_tamil if shop else "",
        "tagline": shop.tagline if shop else "",
        "users": [
            {"id": u.pk, "name": u.display_name, "role": u.role}
            for u in User.objects.filter(is_active=True).order_by("role", "display_name")
        ],
        "counters": [{"id": c.pk, "name": c.name} for c in Counter.objects.filter(is_active=True)],
        "me": user_payload(request.user) if request.user.is_authenticated else None,
    }


@ensure_csrf_cookie
@require_GET
def bootstrap(request):
    return JsonResponse(bootstrap_payload(request))


def _create_user(display_name: str, role: str, pin: str) -> User:
    user = User(username=f"u-{uuid.uuid4().hex[:12]}", display_name=display_name, role=role)
    user.set_password(pin)
    return user


@csrf_protect
@require_POST
def setup(request):
    """First run on the billing laptop: create the owner, the two counters, the shop and the godown."""
    try:
        data = _json_body(request)
        name = validate_name(data.get("owner_name"))
        owner = _create_user(name, User.Role.OWNER, validate_pin(data.get("pin"), User.Role.OWNER))

        from catalog.importer import ensure_default_categories
        from inventory.models import Location

        with transaction.atomic():
            if User.objects.exists():
                raise BusinessError("This PC is already set up.", code="already_setup", status_code=409)
            ShopSettings.get()
            if not Counter.objects.exists():
                Counter.objects.bulk_create([Counter(name=f"Counter {n}", sort_order=n) for n in (1, 2)])
            if not Location.objects.filter(is_sale_location=True).exists():
                Location.objects.create(name="Shop", kind=Location.Kind.SHOP, is_sale_location=True)
            if not Location.objects.filter(kind=Location.Kind.GODOWN).exists():
                Location.objects.create(name="Godown", kind=Location.Kind.GODOWN)
            ensure_default_categories()
            owner.save()
            audit(owner, "setup", "Set up the shop")
    except BusinessError as exc:
        return _error(exc)
    login(request, owner)
    return JsonResponse(bootstrap_payload(request))


@csrf_protect
@require_POST
def login_view(request):
    try:
        data = _json_body(request)
        user = User.objects.filter(pk=data.get("user_id"), is_active=True).first()
        if user is None:
            raise BusinessError("Choose your name.")
        now = timezone.now()
        if user.locked_until and user.locked_until > now:
            minutes = math.ceil((user.locked_until - now).total_seconds() / 60)
            raise BusinessError(
                f"Too many wrong PINs. Try again in {minutes} minute{'s' if minutes > 1 else ''}.",
                code="locked",
                status_code=423,
            )
        pin = str(data.get("pin") or "")
        if not pin or not user.check_password(pin):
            with transaction.atomic():
                User.objects.filter(pk=user.pk).update(failed_pin_attempts=F("failed_pin_attempts") + 1)
                attempts = User.objects.values_list("failed_pin_attempts", flat=True).get(pk=user.pk)
                left = settings.PIN_MAX_ATTEMPTS - attempts
                if left <= 0:
                    User.objects.filter(pk=user.pk).update(
                        failed_pin_attempts=0,
                        locked_until=now + timezone.timedelta(minutes=settings.PIN_LOCK_MINUTES),
                    )
                    audit(user, "login.locked", f"{user.display_name} locked after wrong PINs", user)
            # Raised after the transaction so the lock is saved.
            if left <= 0:
                raise BusinessError(
                    f"Too many wrong PINs. Try again in {settings.PIN_LOCK_MINUTES} minutes.",
                    code="locked",
                    status_code=423,
                )
            raise BusinessError(
                f"Wrong PIN. {left} {'try' if left == 1 else 'tries'} left.", code="wrong_pin", attempts_left=left
            )
        User.objects.filter(pk=user.pk).update(failed_pin_attempts=0, locked_until=None)
    except BusinessError as exc:
        return _error(exc)
    login(request, user)
    return JsonResponse(bootstrap_payload(request))


@csrf_protect
@require_POST
def logout_view(request):
    logout(request)
    return JsonResponse({"ok": True})


# Settings ------------------------------------------------------------------

_PREFIX = re.compile(r"^[A-Za-z0-9/_-]{1,20}$")
_GSTIN = re.compile(r"^[0-9]{2}[A-Z0-9]{13}$")


class SettingsSerializer(serializers.ModelSerializer):
    gst_ready = serializers.BooleanField(read_only=True)

    class Meta:
        model = ShopSettings
        exclude = ["id"]
        read_only_fields = ["updated_at"]

    def validate(self, attrs):
        inst = self.instance
        merged = {f.name: getattr(inst, f.name) for f in ShopSettings._meta.fields} | attrs
        for key in ("estimate_prefix", "gst_prefix", "booking_prefix"):
            if not _PREFIX.match(merged[key] or ""):
                raise BusinessError("Number prefixes may use letters, digits, - / _ (up to 20).")
        if merged["estimate_prefix"] == merged["gst_prefix"]:
            raise BusinessError("Estimate and GST invoice need different number prefixes.")
        for key in ("default_discount_bp", "max_discount_bp", "staff_max_discount_bp"):
            if merged[key] > 5000:
                raise BusinessError("Discounts above 50% are not allowed.")
        if merged["staff_max_discount_bp"] > merged["max_discount_bp"]:
            raise BusinessError("Staff discount limit cannot be more than the owner's limit.")
        if merged["default_discount_bp"] > merged["staff_max_discount_bp"]:
            raise BusinessError("The default discount cannot be more than the staff limit.")
        if merged["gst_rate_bp"] is not None and not 1 <= merged["gst_rate_bp"] <= 2800:
            raise BusinessError("GST rate should be between 0.01% and 28%.")
        gstin = (merged["gstin"] or "").strip().upper()
        if gstin and not _GSTIN.match(gstin):
            raise BusinessError("GSTIN should be 15 letters/digits, e.g. 33ABCDE1234F1Z5.")
        if "gstin" in attrs:
            attrs["gstin"] = gstin
        if "backup_folder" in attrs:
            folder = attrs["backup_folder"].strip().strip('"')
            if folder and not Path(folder).is_dir():
                raise BusinessError("That backup folder does not exist on this PC. Check the Google Drive folder path.")
            attrs["backup_folder"] = folder
        if "owner_whatsapp" in attrs and attrs["owner_whatsapp"]:
            from sales.services import validate_phone

            attrs["owner_whatsapp"] = validate_phone(attrs["owner_whatsapp"])
        return attrs


def settings_payload(request, shop: ShopSettings) -> dict:
    from sales.services import max_discount_bp

    data = SettingsSerializer(shop).data
    data["my_max_discount_bp"] = max_discount_bp(request.user, shop)
    return data


@api_view(["GET", "PATCH"])
@permission_classes([OwnerWriteStaffRead])
def settings_view(request):
    shop = ShopSettings.get()
    if request.method == "PATCH":
        serializer = SettingsSerializer(shop, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            changed = {k: v for k, v in serializer.validated_data.items() if getattr(shop, k) != v}
            shop = serializer.save()
            if changed:
                audit(request.user, "settings.update", "Changed " + ", ".join(sorted(changed)), shop,
                      fields=sorted(changed))
    return Response(settings_payload(request, shop))


@api_view(["GET"])
def me_view(request):
    return Response(user_payload(request.user))


@api_view(["POST"])
def change_my_pin(request):
    user = request.user
    if not user.check_password(str(request.data.get("current_pin") or "")):
        raise BusinessError("Your current PIN is wrong.")
    pin = validate_pin(request.data.get("new_pin"), user.role)
    user.set_password(pin)
    user.save(update_fields=["password"])
    audit(user, "user.pin_change", f"{user.display_name} changed their PIN", user)
    update_session_auth_hash(request, user)
    return Response({"ok": True})


# Users and counters ----------------------------------------------------------


def staff_payload(user: User) -> dict:
    return {
        "id": user.pk,
        "name": user.display_name,
        "role": user.role,
        "is_active": user.is_active,
        "locked": bool(user.locked_until and user.locked_until > timezone.now()),
        "created_at": user.date_joined.isoformat(),
    }


@api_view(["GET", "POST"])
@permission_classes([IsOwner])
def users_view(request):
    if request.method == "POST":
        role = request.data.get("role") or User.Role.STAFF
        if role not in User.Role.values:
            raise BusinessError("Choose Owner or Staff.")
        name = validate_name(request.data.get("name"))
        user = _create_user(name, role, validate_pin(request.data.get("pin"), role))
        with transaction.atomic():
            if User.objects.filter(display_name__iexact=name).exists():
                raise BusinessError("Someone with this name already exists.")
            user.save()
            audit(request.user, "user.create", f"Added {role} {name}", user)
        return Response(staff_payload(user), status=201)
    return Response([staff_payload(u) for u in User.objects.order_by("-is_active", "role", "display_name")])


@api_view(["PATCH"])
@permission_classes([IsOwner])
def user_detail(request, user_id: int):
    user = User.objects.filter(pk=user_id).first()
    if user is None:
        raise NotFound("User not found.")
    data = request.data
    new_pin = None
    if data.get("pin"):
        new_pin = validate_pin(data["pin"], data.get("role", user.role))
        user.set_password(new_pin)
    with transaction.atomic():
        changes = []
        if "name" in data:
            name = validate_name(data["name"])
            if User.objects.filter(display_name__iexact=name).exclude(pk=user.pk).exists():
                raise BusinessError("Someone with this name already exists.")
            user.display_name = name
            changes.append("name")
        if "role" in data and data["role"] != user.role:
            if data["role"] not in User.Role.values:
                raise BusinessError("Choose Owner or Staff.")
            if user.pk == request.user.pk:
                raise BusinessError("You cannot change your own role.")
            user.role = data["role"]
            changes.append("role")
        if "is_active" in data and bool(data["is_active"]) != user.is_active:
            if user.pk == request.user.pk:
                raise BusinessError("You cannot turn off your own login.")
            user.is_active = bool(data["is_active"])
            changes.append("active")
        if new_pin:
            user.failed_pin_attempts = 0
            user.locked_until = None
            changes.append("PIN")
        if user.role != User.Role.OWNER and not User.objects.filter(
            role=User.Role.OWNER, is_active=True
        ).exclude(pk=user.pk).exists():
            raise BusinessError("At least one active owner is needed.")
        user.save()
        if changes:
            audit(request.user, "user.update", f"Changed {', '.join(changes)} for {user.display_name}", user)
    return Response(staff_payload(user))


def counter_payload(counter: Counter) -> dict:
    return {"id": counter.pk, "name": counter.name, "is_active": counter.is_active, "sort_order": counter.sort_order}


@api_view(["GET", "POST"])
@permission_classes([OwnerWriteStaffRead])
def counters_view(request):
    if request.method == "POST":
        name = validate_name(request.data.get("name"))
        with transaction.atomic():
            if Counter.objects.filter(name__iexact=name).exists():
                raise BusinessError("A counter with this name already exists.")
            counter = Counter.objects.create(name=name, sort_order=Counter.objects.count() + 1)
            audit(request.user, "counter.create", f"Added {name}", counter)
        return Response(counter_payload(counter), status=201)
    return Response([counter_payload(c) for c in Counter.objects.all()])


@api_view(["PATCH"])
@permission_classes([IsOwner])
def counter_detail(request, counter_id: int):
    counter = Counter.objects.filter(pk=counter_id).first()
    if counter is None:
        raise NotFound("Counter not found.")
    with transaction.atomic():
        if "name" in request.data:
            name = validate_name(request.data["name"])
            if Counter.objects.filter(name__iexact=name).exclude(pk=counter.pk).exists():
                raise BusinessError("A counter with this name already exists.")
            counter.name = name
        if "is_active" in request.data:
            counter.is_active = bool(request.data["is_active"])
        counter.save()
        audit(request.user, "counter.update", f"Updated {counter.name}", counter)
    return Response(counter_payload(counter))


@api_view(["GET"])
@permission_classes([IsOwner])
def audit_log(request):
    rows = AuditLog.objects.all()[:300]
    return Response(
        [
            {
                "id": r.pk,
                "at": r.created_at.isoformat(),
                "user": r.user_name,
                "action": r.action,
                "summary": r.summary,
            }
            for r in rows
        ]
    )

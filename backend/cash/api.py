from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.errors import BusinessError

from .models import Expense
from .services import add_expense, close_day, day_summary, delete_expense, open_day


def _day(value):
    if not value:
        return timezone.localdate()
    parsed = parse_date(str(value))
    if parsed is None:
        raise BusinessError("Dates should look like 2026-10-26.")
    return parsed


def expense_payload(expense: Expense) -> dict:
    return {
        "id": expense.pk,
        "business_date": expense.business_date.isoformat(),
        "category": expense.category,
        "category_label": expense.get_category_display(),
        "amount_paise": expense.amount_paise,
        "note": expense.note,
        "paid_from_drawer": expense.paid_from_drawer,
        "user": expense.user.display_name if expense.user else "",
        "at": expense.created_at.isoformat(),
    }


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def expenses_view(request):
    if request.method == "POST":
        data = dict(request.data)
        if data.get("business_date"):
            data["business_date"] = _day(data["business_date"])
        return Response(expense_payload(add_expense(request.user, data)), status=201)
    day = _day(request.query_params.get("date"))
    rows = Expense.objects.filter(business_date=day).select_related("user")
    return Response([expense_payload(e) for e in rows])


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def expense_detail(request, expense_id: int):
    delete_expense(request.user, expense_id)
    return Response(status=204)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def day_view(request):
    return Response(day_summary(_day(request.query_params.get("date"))))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def day_open(request):
    open_day(request.user, request.data.get("opening_cash_paise"))
    return Response(day_summary(timezone.localdate()), status=201)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def day_close(request):
    summary = close_day(
        request.user,
        request.data.get("counted_cash_paise"),
        request.data.get("handed_over_paise"),
        str(request.data.get("note") or ""),
    )
    from backups.services import create_backup

    try:
        summary["backup"] = create_backup("day-close", kind="day")
    except Exception as exc:  # noqa: BLE001 - closing must not fail because of a backup problem
        summary["backup"] = {"error": str(exc)}
    return Response(summary)

from django.db import connection
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from backups.services import read_status
from core.errors import BusinessError
from core.permissions import is_owner

from .reports import build, to_xlsx
from .stats import dashboard_stats

MAX_DAYS = 400


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def report_view(request, kind: str):
    report = build(kind, request.query_params, is_owner(request.user))
    if request.query_params.get("download") == "xlsx":
        day = request.query_params.get("from") or timezone.localdate().isoformat()
        response = HttpResponse(
            to_xlsx(report), content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        response["Content-Disposition"] = f'attachment; filename="{kind}-{day}.xlsx"'
        return response
    return Response(report)


def _period(params, today):
    try:
        start = parse_date(params.get("from") or "") or today
        end = parse_date(params.get("to") or "") or start
    except ValueError:
        raise BusinessError("That date does not exist.")
    if end < start:
        raise BusinessError("The 'to' date is before the 'from' date.")
    if (end - start).days >= MAX_DAYS:
        raise BusinessError(f"Choose up to {MAX_DAYS} days.")
    return start, end


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def dashboard(request):
    """Sales for the chosen dates (today by default). Staff never see profit."""
    owner = is_owner(request.user)
    today = timezone.localdate()
    start, end = _period(request.query_params, today)
    connection.ensure_connection()
    result = {
        "today": today.isoformat(),
        "is_owner": owner,
        "period": {"from": start.isoformat(), "to": end.isoformat(), "days": (end - start).days + 1},
        "stats": dashboard_stats(connection.connection, start, end, today, include_profit=owner),
    }
    if owner:
        result["backup"] = read_status()
    return Response(result)

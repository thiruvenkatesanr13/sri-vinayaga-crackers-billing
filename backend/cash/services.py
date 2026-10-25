from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied

from core.audit import audit
from core.errors import BusinessError
from core.money import rupees
from core.permissions import is_owner
from sales.models import Invoice, Payment, PaymentMode

from .models import DaySession, Expense


def add_expense(user, data: dict) -> Expense:
    category = data.get("category")
    if category not in Expense.Category.values:
        raise BusinessError("Choose what the expense was for.")
    try:
        amount = int(data.get("amount_paise") or 0)
    except (TypeError, ValueError):
        raise BusinessError("Check the amount.")
    if amount <= 0:
        raise BusinessError("Amount must be more than zero.")
    today = timezone.localdate()
    day = data.get("business_date") or today
    if day != today and not is_owner(user):
        raise PermissionDenied("Only the owner can add an expense for another day.")
    if day > today:
        raise BusinessError("Expenses cannot be added for a future date.")
    with transaction.atomic():
        expense = Expense.objects.create(
            business_date=day,
            category=category,
            amount_paise=amount,
            note=str(data.get("note") or "").strip()[:200],
            paid_from_drawer=bool(data.get("paid_from_drawer", True)),
            user=user,
        )
        audit(user, "expense.add", f"{expense.get_category_display()} {rupees(amount)}", expense)
    return expense


def delete_expense(user, expense_id: int) -> None:
    if not is_owner(user):
        raise PermissionDenied("Only the owner can remove an expense.")
    with transaction.atomic():
        expense = Expense.objects.filter(pk=expense_id).first()
        if expense is None:
            raise NotFound("Expense not found.")
        if DaySession.objects.filter(business_date=expense.business_date, closed_at__isnull=False).exists():
            raise BusinessError("That day is already closed.")
        audit(
            user,
            "expense.delete",
            f"Removed {expense.get_category_display()} {rupees(expense.amount_paise)} on {expense.business_date}",
            expense,
        )
        expense.delete()


def day_summary(day) -> dict:
    session = DaySession.objects.filter(business_date=day).first()
    payments = Payment.objects.filter(business_date=day)
    by_mode = {mode: 0 for mode in PaymentMode.values}
    for row in payments.values("mode").annotate(total=Sum("amount_paise")):
        by_mode[row["mode"]] = row["total"] or 0
    cash = {kind: 0 for kind in Payment.Kind.values}
    for row in payments.filter(mode=PaymentMode.CASH).values("kind").annotate(total=Sum("amount_paise")):
        cash[row["kind"]] = row["total"] or 0

    active = Invoice.objects.filter(business_date=day, status=Invoice.Status.ACTIVE)
    sales = active.aggregate(count=Count("id"), total=Sum("total_paise"), discount=Sum("discount_paise"))
    cancelled = Invoice.objects.filter(business_date=day, status=Invoice.Status.CANCELLED).count()

    expenses = Expense.objects.filter(business_date=day)
    expense_total = expenses.aggregate(total=Sum("amount_paise"))["total"] or 0
    from_drawer = expenses.filter(paid_from_drawer=True).aggregate(total=Sum("amount_paise"))["total"] or 0
    by_category = {
        row["category"]: row["total"] for row in expenses.values("category").annotate(total=Sum("amount_paise"))
    }

    opening = session.opening_cash_paise if session else None
    expected = (opening or 0) + by_mode[PaymentMode.CASH] - from_drawer
    return {
        "business_date": day.isoformat(),
        "opened": session is not None,
        "closed": bool(session and session.closed_at),
        "opening_cash_paise": opening,
        "sales_count": sales["count"] or 0,
        "sales_total_paise": sales["total"] or 0,
        "discount_total_paise": sales["discount"] or 0,
        "cancelled_count": cancelled,
        "payments_by_mode": by_mode,
        "cash_sales_paise": cash[Payment.Kind.SALE],
        "cash_advances_paise": cash[Payment.Kind.ADVANCE],
        "cash_refunds_paise": cash[Payment.Kind.REFUND],
        "expenses_total_paise": expense_total,
        "expenses_from_drawer_paise": from_drawer,
        "expenses_by_category": by_category,
        "expected_cash_paise": expected,
        "counted_cash_paise": session.counted_cash_paise if session else None,
        "difference_paise": session.difference_paise if session else None,
        "handed_over_paise": session.handed_over_paise if session else None,
        "closed_at": session.closed_at.isoformat() if session and session.closed_at else None,
        "closed_by": session.closed_by.display_name if session and session.closed_by else None,
        "note": session.note if session else "",
    }


def open_day(user, opening_cash_paise) -> DaySession:
    try:
        opening = int(opening_cash_paise)
    except (TypeError, ValueError):
        raise BusinessError("Enter the opening cash.")
    if opening < 0:
        raise BusinessError("Opening cash cannot be negative.")
    today = timezone.localdate()
    with transaction.atomic():
        if DaySession.objects.filter(business_date=today).exists():
            raise BusinessError("Today is already opened.")
        session = DaySession.objects.create(business_date=today, opening_cash_paise=opening, opened_by=user)
        audit(user, "day.open", f"Opened {today} with {rupees(opening)}", session)
    return session


def close_day(user, counted_cash_paise, handed_over_paise=None, note: str = "") -> dict:
    try:
        counted = int(counted_cash_paise)
        handed = int(handed_over_paise) if handed_over_paise not in (None, "") else None
    except (TypeError, ValueError):
        raise BusinessError("Check the cash amounts.")
    if counted < 0 or (handed is not None and handed < 0):
        raise BusinessError("Cash amounts cannot be negative.")
    if handed is not None and handed > counted:
        raise BusinessError("Cash handed over cannot be more than the counted cash.")
    today = timezone.localdate()
    with transaction.atomic():
        session = DaySession.objects.filter(business_date=today).first()
        if session is None:
            raise BusinessError("Open the day first by entering the opening cash.", code="day_not_open")
        if session.closed_at:
            raise BusinessError("Today is already closed.")
        summary = day_summary(today)
        session.expected_cash_paise = summary["expected_cash_paise"]
        session.counted_cash_paise = counted
        session.difference_paise = counted - summary["expected_cash_paise"]
        session.handed_over_paise = handed
        session.note = (note or "").strip()[:200]
        session.closed_at = timezone.now()
        session.closed_by = user
        session.save()
        audit(
            user,
            "day.close",
            f"Closed {today}: counted {rupees(counted)}, difference {rupees(session.difference_paise)}",
            session,
        )
    return day_summary(today)

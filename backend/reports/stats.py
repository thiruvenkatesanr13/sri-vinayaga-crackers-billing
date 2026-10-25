"""Dashboard numbers, computed with plain SQL on the shop's database.

Sales, money, expenses and best sellers follow the chosen dates; stock to refill,
bookings due and bills on hold are always as of now. Cancelled bills are never
counted as sales.
"""

import sqlite3
from datetime import date, timedelta

MODES = ("cash", "upi", "card", "credit_card", "bank")
TOP_PRODUCTS = 8


def _one(conn: sqlite3.Connection, sql: str, params=()):
    return conn.execute(sql, params).fetchone()


def _chart(daily: dict[str, tuple[int, int]], start: date, end: date) -> dict:
    """Bars by day up to a month, then by week, then by month."""
    days = (end - start).days + 1
    unit = "day" if days <= 31 else "week" if days <= 26 * 7 else "month"
    points: dict[date, dict] = {}
    day = start
    while day <= end:
        if unit == "day":
            key = day
        elif unit == "week":
            key = max(start, day - timedelta(days=day.weekday()))
        else:
            key = max(start, day.replace(day=1))
        point = points.setdefault(key, {"date": key.isoformat(), "to": key.isoformat(), "total_paise": 0, "bills": 0})
        amount, bills = daily.get(day.isoformat(), (0, 0))
        point["total_paise"] += amount
        point["bills"] += bills
        point["to"] = day.isoformat()
        day += timedelta(days=1)
    return {"unit": unit, "from": start.isoformat(), "to": end.isoformat(), "points": list(points.values())}


def dashboard_stats(conn: sqlite3.Connection, start: date, end: date, today: date, *, include_profit: bool) -> dict:
    period = (start.isoformat(), end.isoformat())
    in_period = "business_date BETWEEN ? AND ?"

    count, total, discount = _one(
        conn,
        "SELECT COUNT(*), COALESCE(SUM(total_paise), 0), COALESCE(SUM(discount_paise), 0) "
        f"FROM sales_invoice WHERE status = 'active' AND {in_period}",
        period,
    )
    cancelled = _one(conn, f"SELECT COUNT(*) FROM sales_invoice WHERE status = 'cancelled' AND {in_period}", period)[0]

    payments = {mode: 0 for mode in MODES}
    for mode, amount in conn.execute(
        f"SELECT mode, COALESCE(SUM(amount_paise), 0) FROM sales_payment WHERE {in_period} GROUP BY mode", period
    ):
        payments[mode] = amount

    # A single day is charted with the six days before it, so there is something to compare.
    chart_start = end - timedelta(days=6) if start == end else start
    # Dates are read as text: the app's connection would otherwise turn them into date objects.
    daily = {
        day: (amount, bills)
        for day, amount, bills in conn.execute(
            "SELECT CAST(business_date AS TEXT), COALESCE(SUM(total_paise), 0), COUNT(*) FROM sales_invoice "
            f"WHERE status = 'active' AND {in_period} GROUP BY business_date",
            (chart_start.isoformat(), end.isoformat()),
        )
    }

    top_products = [
        {"code": r[0], "name": r[1], "unit": r[2], "qty": r[3], "amount_paise": r[4]}
        for r in conn.execute(
            "SELECT g.code, g.name, p.unit_name, g.qty, g.amount FROM ("
            "  SELECT l.product_code AS code, l.product_name AS name, MIN(l.product_id) AS product_id, "
            "  SUM(l.base_qty) AS qty, SUM(l.amount_paise) AS amount "
            "  FROM sales_invoiceline l JOIN sales_invoice i ON i.id = l.invoice_id "
            "  WHERE i.status = 'active' AND i.business_date BETWEEN ? AND ? "
            "  GROUP BY l.product_code, l.product_name ORDER BY amount DESC, code LIMIT ?"
            ") g LEFT JOIN catalog_product p ON p.id = g.product_id ORDER BY g.amount DESC, g.code",
            (*period, TOP_PRODUCTS),
        )
    ]

    low_default = (_one(conn, "SELECT low_stock_default FROM core_shopsettings WHERE id = 1") or (None,))[0]
    alerts = [
        {
            "code": code,
            "name": name,
            "unit": unit,
            "location": location,
            "qty": qty,
            "level": level,
            "status": "out" if qty <= 0 else "low",
        }
        for code, name, unit, location, qty, level in conn.execute(
            "SELECT p.code, p.name, p.unit_name, loc.name, COALESCE(b.quantity, 0), COALESCE(p.low_stock_level, ?) "
            "FROM catalog_product p CROSS JOIN inventory_location loc "
            "LEFT JOIN inventory_stockbalance b ON b.product_id = p.id AND b.location_id = loc.id "
            "WHERE p.is_active = 1 AND loc.is_active = 1 "
            "AND NOT (p.is_gift_box = 1 AND p.gift_box_mode = 'components') "
            "AND (loc.is_sale_location = 1 OR b.id IS NOT NULL) "
            "AND (COALESCE(b.quantity, 0) <= 0 OR COALESCE(b.quantity, 0) <= COALESCE(p.low_stock_level, ?, -1)) "
            "ORDER BY COALESCE(b.quantity, 0), p.code",
            (low_default, low_default),
        )
    ]

    day = today.isoformat()
    bookings_due = [
        {
            "number": r[0],
            "customer_name": r[1],
            "customer_phone": r[2],
            "delivery_date": r[3],
            "status": r[4],
            "overdue": r[3] < day,
        }
        for r in conn.execute(
            "SELECT number, customer_name, customer_phone, CAST(delivery_date AS TEXT), status FROM sales_booking "
            "WHERE status IN ('booked', 'ready') AND delivery_date <= ? ORDER BY delivery_date, id",
            ((today + timedelta(days=1)).isoformat(),),
        )
    ]

    result = {
        "sales_total_paise": total,
        "bills": count,
        "average_bill_paise": (total // count) if count else 0,
        "discount_total_paise": discount,
        "cancelled_bills": cancelled,
        "payments_by_mode": payments,
        "chart": _chart(daily, chart_start, end),
        "top_products": top_products,
        "stock_alerts": alerts,
        "out_of_stock": sum(1 for a in alerts if a["status"] == "out"),
        "low_stock": sum(1 for a in alerts if a["status"] == "low"),
        "bookings_due": bookings_due,
        "held_bills": _one(conn, "SELECT COUNT(*) FROM sales_heldbill")[0],
        "expenses_paise": _one(
            conn, f"SELECT COALESCE(SUM(amount_paise), 0) FROM cash_expense WHERE {in_period}", period
        )[0],
    }
    if include_profit:
        revenue, cost, unknown_bills, unknown_revenue = _one(
            conn,
            "SELECT COALESCE(SUM(CASE WHEN cost_paise IS NOT NULL THEN taxable_paise END), 0), "
            "COALESCE(SUM(cost_paise), 0), "
            "COALESCE(SUM(CASE WHEN cost_paise IS NULL THEN 1 ELSE 0 END), 0), "
            "COALESCE(SUM(CASE WHEN cost_paise IS NULL THEN taxable_paise ELSE 0 END), 0) "
            f"FROM sales_invoice WHERE status = 'active' AND {in_period}",
            period,
        )
        result["profit"] = {
            "profit_paise": revenue - cost,
            "costed_sales_paise": revenue,
            "bills_without_cost": unknown_bills,
            "sales_without_cost_paise": unknown_revenue,
        }
    return result

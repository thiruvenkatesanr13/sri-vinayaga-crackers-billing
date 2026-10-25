"""Money helpers. All amounts are integer paise; percentages are basis points.

Rounding is always half-up, so the browser (frontend/src/lib/money.ts) and the
server compute exactly the same totals.
"""


def div_half_up(numerator: int, denominator: int) -> int:
    """Integer division rounded half-up, for numerator >= 0 and denominator > 0."""
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    if numerator < 0:
        raise ValueError("numerator must not be negative")
    return (2 * numerator + denominator) // (2 * denominator)


def percent_of(amount_paise: int, rate_bp: int) -> int:
    """rate_bp basis points of amount, rounded half-up (1000 bp = 10%)."""
    return div_half_up(amount_paise * rate_bp, 10000)


def round_to_rupee(amount_paise: int) -> int:
    """Nearest whole rupee, half-up (Rs 10.50 -> Rs 11)."""
    return div_half_up(amount_paise, 100) * 100


def rupees(amount_paise: int | None) -> str:
    if amount_paise is None:
        return ""
    sign = "-" if amount_paise < 0 else ""
    value = abs(amount_paise)
    whole, paise = divmod(value, 100)
    digits = str(whole)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join(groups + [tail])
    return f"{sign}Rs {digits}.{paise:02d}"


def bill_totals(
    subtotal_paise: int,
    discount_bp: int,
    *,
    gst_rate_bp: int | None = None,
    prices_include_gst: bool | None = None,
    round_off: bool = True,
) -> dict:
    """Totals for one bill. Mirrors computeTotals() in frontend/src/lib/money.ts."""
    if subtotal_paise < 0:
        raise ValueError("subtotal must not be negative")
    discount = percent_of(subtotal_paise, discount_bp)
    after_discount = subtotal_paise - discount

    if gst_rate_bp:
        if prices_include_gst:
            taxable = div_half_up(after_discount * 10000, 10000 + gst_rate_bp)
            tax = after_discount - taxable
            before_round = after_discount
        else:
            taxable = after_discount
            tax = percent_of(after_discount, gst_rate_bp)
            before_round = after_discount + tax
    else:
        taxable = after_discount
        tax = 0
        before_round = after_discount

    cgst = tax // 2
    sgst = tax - cgst
    total = round_to_rupee(before_round) if round_off else before_round
    return {
        "subtotal_paise": subtotal_paise,
        "discount_paise": discount,
        "taxable_paise": taxable,
        "cgst_paise": cgst,
        "sgst_paise": sgst,
        "round_off_paise": total - before_round,
        "total_paise": total,
    }

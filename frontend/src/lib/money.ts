/** Money in integer paise. Totals use the same half-up rounding as the server
 *  (backend/core/money.py), so the screen always matches the saved bill. */

export function divHalfUp(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new Error("denominator must be positive");
  if (numerator < 0) throw new Error("numerator must not be negative");
  const n = BigInt(Math.round(numerator));
  const d = BigInt(Math.round(denominator));
  return Number((2n * n + d) / (2n * d));
}

export function percentOf(amountPaise: number, rateBp: number): number {
  return divHalfUp(amountPaise * rateBp, 10000);
}

export function roundToRupee(amountPaise: number): number {
  return divHalfUp(amountPaise, 100) * 100;
}

export interface Totals {
  subtotal_paise: number;
  discount_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  round_off_paise: number;
  total_paise: number;
}

export function computeTotals(
  subtotalPaise: number,
  discountBp: number,
  opts: { gstRateBp?: number | null; pricesIncludeGst?: boolean | null; roundOff?: boolean } = {},
): Totals {
  const discount = percentOf(subtotalPaise, discountBp);
  const afterDiscount = subtotalPaise - discount;
  let taxable = afterDiscount;
  let tax = 0;
  let beforeRound = afterDiscount;
  if (opts.gstRateBp) {
    if (opts.pricesIncludeGst) {
      taxable = divHalfUp(afterDiscount * 10000, 10000 + opts.gstRateBp);
      tax = afterDiscount - taxable;
    } else {
      tax = percentOf(afterDiscount, opts.gstRateBp);
      beforeRound = afterDiscount + tax;
    }
  }
  const cgst = Math.floor(tax / 2);
  const total = opts.roundOff === false ? beforeRound : roundToRupee(beforeRound);
  return {
    subtotal_paise: subtotalPaise,
    discount_paise: discount,
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: tax - cgst,
    round_off_paise: total - beforeRound,
    total_paise: total,
  };
}

const grouping = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const groupingWhole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** "₹1,23,456.00" */
export function rs(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "—";
  const sign = paise < 0 ? "−" : "";
  return `${sign}₹${grouping.format(Math.abs(paise) / 100)}`;
}

/** "₹1,23,456" when there are no paise, else with paise. */
export function rsShort(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "—";
  if (paise % 100 !== 0) return rs(paise);
  const sign = paise < 0 ? "−" : "";
  return `${sign}₹${groupingWhole.format(Math.abs(paise) / 100)}`;
}

/** Parse "1,234.50" typed by a person into paise; null when empty or invalid. */
export function toPaise(text: string): number | null {
  const cleaned = text.replace(/[₹,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function paiseToInput(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "";
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

/** Basis points to a percent label: 1000 -> "10%". */
export function pct(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

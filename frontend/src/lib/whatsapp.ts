import { fmtDate, fmtTime } from "./format";
import { pct, rs } from "./money";
import { MODE_LABEL, type Bill } from "./types";

/** Opens WhatsApp with a ready message (a bill for a customer, or the owner's day-closing summary). The person presses Send. */
export function openWhatsApp(phone: string, text: string): void {
  const digits = phone.replace(/\D/g, "").slice(-10);
  window.open(`https://wa.me/91${digits}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}

export function isValidPhone(phone: string): boolean {
  return /^[6-9]\d{9}$/.test(phone.replace(/\D/g, "").slice(-10));
}

/** The bill as a WhatsApp message, laid out like the printed bill. WhatsApp links carry text only, not a PDF. */
export function billMessage(bill: Bill): string {
  const shop = bill.shop;
  const gst = bill.doc_type === "gst";
  const out = [`*${shop.shop_name}*`];
  if (shop.phones) out.push(`Ph: ${shop.phones}`);
  if (gst && shop.gstin) out.push(`GSTIN: ${shop.gstin}`);
  out.push("", `*${gst ? "Tax invoice" : "Estimate"} ${bill.number}*`, `${fmtDate(bill.at)} ${fmtTime(bill.at)}`);
  if (bill.status === "cancelled") out.push("*CANCELLED*");
  out.push("");
  let group = "";
  for (const line of bill.lines) {
    if (line.group_label && line.group_label !== group) out.push(`_${line.group_label}_`);
    group = line.group_label;
    out.push(`${line.name}: ${line.qty} ${line.unit_label} × ${rs(line.unit_price_paise)} = ${rs(line.amount_paise)}`);
  }
  out.push("", `Items total (${bill.lines.reduce((n, l) => n + l.qty, 0)}): ${rs(bill.subtotal_paise)}`);
  if (bill.discount_paise) out.push(`Discount (${pct(bill.discount_bp)}): −${rs(bill.discount_paise)}`);
  if (bill.adjustment_paise) out.push(`Adjustment: ${bill.adjustment_paise > 0 ? "+" : ""}${rs(bill.adjustment_paise)}`);
  if (gst) {
    const half = pct((bill.gst_rate_bp ?? 0) / 2);
    out.push(`Taxable value: ${rs(bill.taxable_paise)}`, `CGST ${half}: ${rs(bill.cgst_paise)}`, `SGST ${half}: ${rs(bill.sgst_paise)}`);
  }
  if (bill.round_off_paise) out.push(`Round off: ${rs(bill.round_off_paise)}`);
  out.push(`*Total: ${rs(bill.total_paise)}*`);
  if (bill.advance_paise) out.push(`Advance paid: −${rs(bill.advance_paise)}`);
  for (const payment of bill.payments.filter((p) => p.kind !== "refund")) {
    out.push(`Paid by ${MODE_LABEL[payment.mode] ?? payment.mode}: ${rs(payment.amount_paise)}`);
  }
  if (bill.balance_paise > 0) out.push(`*Balance due: ${rs(bill.balance_paise)}*`);
  else if (bill.balance_paise < 0) out.push(`Paid extra: ${rs(-bill.balance_paise)}`);
  const footer = [shop.footer_thanks, shop.footer_terms].filter(Boolean);
  if (footer.length) out.push("", ...footer);
  return out.join("\n");
}

import { Fragment } from "react";
import { brand } from "../lib/brand";
import { fmtDate, fmtTime } from "../lib/format";
import { pct, rs } from "../lib/money";
import { MODE_LABEL, type Bill } from "../lib/types";

/** The bill as printed on the 80 mm thermal printer. */
export default function Receipt({ bill, duplicate }: { bill: Bill; duplicate: boolean }) {
  const shop = bill.shop;
  const gst = bill.doc_type === "gst";
  const paid = bill.payments.filter((p) => p.kind !== "refund");
  let lastGroup = "";

  return (
    <article className="receipt" aria-label={`Bill ${bill.number}`}>
      <header className="r-center">
        <img className="r-logo" src={brand.receipt} alt="" width={563} height={341} />
        <div className="r-shop">{shop.shop_name}</div>
        {shop.shop_name_tamil ? <div className="r-tamil">{shop.shop_name_tamil}</div> : null}
        {shop.tagline ? <div>{shop.tagline}</div> : null}
        {shop.address ? <div style={{ whiteSpace: "pre-line" }}>{shop.address}</div> : null}
        {shop.phones ? <div>Ph: {shop.phones}</div> : null}
        {gst && shop.gstin ? <div>GSTIN: {shop.gstin}</div> : null}
      </header>

      <div className="r-title">
        {gst ? "TAX INVOICE" : "ESTIMATE"}
        {duplicate ? " · DUPLICATE" : ""}
      </div>
      {bill.status === "cancelled" ? <div className="r-stamp">CANCELLED</div> : null}

      <dl className="r-meta">
        <dt>Bill</dt>
        <dd>{bill.number}</dd>
        <dt>Date</dt>
        <dd>
          {fmtDate(bill.at)} {fmtTime(bill.at)}
        </dd>
        <dt>{bill.counter_name}</dt>
        <dd>{bill.user_name}</dd>
        {bill.customer_name || bill.customer_phone ? (
          <>
            <dt>Customer</dt>
            <dd>{[bill.customer_name, bill.customer_phone].filter(Boolean).join(" · ")}</dd>
          </>
        ) : null}
        {bill.booking_number ? (
          <>
            <dt>Booking</dt>
            <dd>{bill.booking_number}</dd>
          </>
        ) : null}
      </dl>

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((line) => {
            const header = line.group_label && line.group_label !== lastGroup;
            lastGroup = line.group_label;
            return (
              <Fragment key={line.line_no}>
                {header ? (
                  <tr className="r-group">
                    <td colSpan={4}>{line.group_label}</td>
                  </tr>
                ) : null}
                <tr>
                  <td className="item">{line.name}</td>
                  <td>
                    {line.qty} {line.unit_label}
                  </td>
                  <td>{(line.unit_price_paise / 100).toFixed(2)}</td>
                  <td>{(line.amount_paise / 100).toFixed(2)}</td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>

      <dl className="r-sums">
        <dt>Items total ({bill.lines.reduce((n, l) => n + l.qty, 0)})</dt>
        <dd>{rs(bill.subtotal_paise)}</dd>
        {bill.discount_paise ? (
          <>
            <dt>Discount ({pct(bill.discount_bp)})</dt>
            <dd>−{rs(bill.discount_paise)}</dd>
          </>
        ) : null}
        {gst ? (
          <>
            <dt>Taxable value</dt>
            <dd>{rs(bill.taxable_paise)}</dd>
            <dt>CGST {pct((bill.gst_rate_bp ?? 0) / 2)}</dt>
            <dd>{rs(bill.cgst_paise)}</dd>
            <dt>SGST {pct((bill.gst_rate_bp ?? 0) / 2)}</dt>
            <dd>{rs(bill.sgst_paise)}</dd>
          </>
        ) : null}
        {bill.round_off_paise ? (
          <>
            <dt>Round off</dt>
            <dd>{rs(bill.round_off_paise)}</dd>
          </>
        ) : null}
      </dl>
      <dl className="r-sums r-total">
        <dt>TOTAL</dt>
        <dd>{rs(bill.total_paise)}</dd>
      </dl>
      <dl className="r-sums" style={{ borderTop: 0 }}>
        {bill.advance_paise ? (
          <>
            <dt>Advance paid</dt>
            <dd>−{rs(bill.advance_paise)}</dd>
          </>
        ) : null}
        {paid.map((p) => (
          <Fragment key={p.id}>
            <dt>Paid by {MODE_LABEL[p.mode] ?? p.mode}</dt>
            <dd>{rs(p.amount_paise)}</dd>
            {p.cash_tendered_paise ? (
              <>
                <dt>Cash given / change</dt>
                <dd>
                  {rs(p.cash_tendered_paise)} / {rs(p.change_paise)}
                </dd>
              </>
            ) : null}
          </Fragment>
        ))}
      </dl>

      <footer className="r-foot">
        {gst && shop.hsn_code ? <div>HSN {shop.hsn_code}</div> : null}
        {gst && bill.prices_include_gst ? <div>Prices include GST</div> : null}
        {shop.upi_id ? <div>UPI: {shop.upi_id}</div> : null}
        {shop.footer_terms ? <div>{shop.footer_terms}</div> : null}
        {shop.footer_thanks ? <div style={{ fontWeight: 700, marginTop: "1mm" }}>{shop.footer_thanks}</div> : null}
      </footer>
    </article>
  );
}

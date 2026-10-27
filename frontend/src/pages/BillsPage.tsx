import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Printer, ScreenShare, Search } from "lucide-react";
import { api, errorText, query } from "../lib/api";
import { fmtDate, fmtDateTime, fmtTime, todayIso } from "../lib/format";
import { pct, rs } from "../lib/money";
import { printBill, useBillOutput } from "../lib/print";
import { useSession } from "../lib/session";
import { MODE_LABEL, type Bill, type BillSummary, type Paged } from "../lib/types";
import { Badge, Button, Dialog, Empty, Field, Loading, Notice, PageHead, useToast } from "../components/ui";
import WhatsAppBillButton from "../components/WhatsAppBillButton";

type BillPage = Paged<BillSummary> & { active_total_paise: number };

export function BillDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { isOwner } = useSession();
  const client = useQueryClient();
  const notify = useToast();
  const onScreen = useBillOutput() === "screen";
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const bill = useQuery({ queryKey: ["bill", id], queryFn: () => api.get<Bill>(`/api/bills/${id}`), enabled: id !== null });

  const cancel = useMutation({
    mutationFn: () => api.post<Bill>(`/api/bills/${id}/cancel`, { reason }),
    onSuccess: (updated) => {
      client.setQueryData(["bill", id], updated);
      void client.invalidateQueries({ queryKey: ["bills"] });
      void client.invalidateQueries({ queryKey: ["products"] });
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      setCancelling(false);
      setReason("");
      notify(`Bill ${updated.number} cancelled. Stock is back in the shop.`);
    },
    onError: (error) => notify(errorText(error), "bad"),
  });

  const data = bill.data;
  return (
    <>
      <Dialog
        open={id !== null && !cancelling}
        title={data ? `Bill ${data.number}` : "Bill"}
        onClose={onClose}
        wide
        footer={
          data ? (
            <>
              {isOwner && data.status === "active" ? (
                <Button variant="danger" onClick={() => setCancelling(true)}>
                  <Ban size={16} aria-hidden /> Cancel bill
                </Button>
              ) : null}
              <span style={{ flex: 1 }} />
              {onScreen ? null : (
                <Link className="btn" to={`/print/${data.id}`}>
                  Print view
                </Link>
              )}
              <WhatsAppBillButton bill={data} />
              <Button variant="primary" onClick={() => printBill(data).catch((e) => notify(errorText(e), "bad"))}>
                {onScreen ? <ScreenShare size={16} aria-hidden /> : <Printer size={16} aria-hidden />}
                {onScreen ? "Show the bill" : "Print again"}
              </Button>
            </>
          ) : null
        }
      >
        {bill.isPending ? <Loading /> : null}
        {bill.isError ? <Notice tone="bad">{errorText(bill.error)}</Notice> : null}
        {data ? (
          <div className="stack">
            <div className="row">
              {data.status === "cancelled" ? <Badge tone="bad">Cancelled</Badge> : <Badge tone="good">Active</Badge>}
              {data.status === "active" && data.balance_paise > 0 ? <Badge tone="warn">Balance due {rs(data.balance_paise)}</Badge> : null}
              <Badge>{data.doc_type === "gst" ? "GST invoice" : "Estimate"}</Badge>
              {data.print_count > 1 ? <Badge>Printed {data.print_count} times</Badge> : null}
              <span className="muted small">
                {fmtDate(data.at)} {fmtTime(data.at)} · {data.counter_name} · {data.user_name}
              </span>
            </div>
            {data.status === "cancelled" ? (
              <Notice tone="bad">
                Cancelled by {data.cancelled_by} on {fmtDateTime(data.cancelled_at)}: {data.cancel_reason}
              </Notice>
            ) : null}
            {data.customer_name || data.customer_phone ? (
              <p className="small">
                Customer: <strong>{data.customer_name || "—"}</strong> {data.customer_phone}
                {data.booking_number ? ` · Booking ${data.booking_number}` : ""}
              </p>
            ) : null}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Rate</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.line_no}>
                      <td>
                        {l.name} <span className="muted small">{l.code}</span>
                        {l.group_label ? <div className="small muted">{l.group_label}</div> : null}
                      </td>
                      <td className="num">
                        {l.qty} {l.unit_label}
                      </td>
                      <td className="num">
                        {rs(l.unit_price_paise)}
                        {l.list_price_paise !== null ? <div className="small muted">usually {rs(l.list_price_paise)}</div> : null}
                      </td>
                      <td className="num">{rs(l.amount_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="split">
              <dl className="kv">
                <dt>Items total</dt>
                <dd>{rs(data.subtotal_paise)}</dd>
                {data.discount_paise ? (
                  <>
                    <dt>Discount {pct(data.discount_bp)}</dt>
                    <dd>−{rs(data.discount_paise)}</dd>
                  </>
                ) : null}
                {data.adjustment_paise ? (
                  <>
                    <dt>Adjustment (total typed)</dt>
                    <dd>
                      {data.adjustment_paise > 0 ? "+" : ""}
                      {rs(data.adjustment_paise)}
                    </dd>
                  </>
                ) : null}
                {data.doc_type === "gst" ? (
                  <>
                    <dt>CGST + SGST</dt>
                    <dd>{rs(data.cgst_paise + data.sgst_paise)}</dd>
                  </>
                ) : null}
                {data.round_off_paise ? (
                  <>
                    <dt>Round off</dt>
                    <dd>{rs(data.round_off_paise)}</dd>
                  </>
                ) : null}
                <dt>Total</dt>
                <dd style={{ fontSize: "var(--text-md)" }}>{rs(data.total_paise)}</dd>
                {data.advance_paise ? (
                  <>
                    <dt>Advance (booking)</dt>
                    <dd>−{rs(data.advance_paise)}</dd>
                  </>
                ) : null}
                {isOwner && data.cost_paise !== undefined ? (
                  <>
                    <dt>Purchase cost</dt>
                    <dd>{data.cost_paise === null ? "Not known" : rs(data.cost_paise)}</dd>
                  </>
                ) : null}
              </dl>
              <dl className="kv">
                {data.payments.map((p) => (
                  <PaymentLine
                    key={p.id}
                    label={`${p.kind === "refund" ? "Returned" : "Paid"} by ${MODE_LABEL[p.mode]}`}
                    amount={p.amount_paise}
                    note={p.reference}
                  />
                ))}
                {data.balance_paise ? (
                  <>
                    <dt>{data.balance_paise > 0 ? "Balance due" : "Paid extra"}</dt>
                    <dd className="balance">{rs(Math.abs(data.balance_paise))}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={cancelling}
        title={`Cancel bill ${data?.number ?? ""}`}
        onClose={() => setCancelling(false)}
        footer={
          <>
            <Button onClick={() => setCancelling(false)}>Keep bill</Button>
            <Button variant="danger" disabled={reason.trim().length < 3} loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel bill
            </Button>
          </>
        }
      >
        <div className="stack">
          <Notice tone="warn">
            The items go back into shop stock and the money paid ({data ? rs(data.amount_due_paise - data.balance_paise) : ""}) is
            recorded as returned to the customer. The bill stays in the list, marked cancelled. This cannot be undone.
          </Notice>
          <Field label="Why is this bill cancelled?">
            <textarea className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

function PaymentLine({ label, amount, note }: { label: string; amount: number; note: string }) {
  return (
    <>
      <dt>
        {label}
        {note ? <div className="small muted">{note}</div> : null}
      </dt>
      <dd>{rs(amount)}</dd>
    </>
  );
}

export default function BillsPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [status, setStatus] = useState("");
  const [docType, setDocType] = useState("");
  const [limit, setLimit] = useState(50);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const bills = useQuery({
    queryKey: ["bills", { q, from, to, status, docType, limit }],
    queryFn: () =>
      api.get<BillPage>(`/api/bills${query({ q, from: q ? "" : from, to: q ? "" : to, status, doc_type: docType, limit })}`),
    placeholderData: keepPreviousData,
  });

  const data = bills.data;
  return (
    <div className="page">
      <PageHead
        title="Bills"
        subtitle={
          data ? `${data.count} bill${data.count === 1 ? "" : "s"} · ${rs(data.active_total_paise)} not counting cancelled` : undefined
        }
      />
      <div className="toolbar">
        <div className="field" style={{ flex: "1 1 260px" }}>
          <span>Find</span>
          <div className="search">
            <Search size={16} aria-hidden />
            <input
              className="input"
              placeholder="Bill number, customer name or phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <Field label="From">
          <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} disabled={!!q} />
        </Field>
        <Field label="To">
          <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} disabled={!!q} />
        </Field>
        <Field label="Status">
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Field>
        <Field label="Type">
          <select className="select" value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="">All</option>
            <option value="estimate">Estimate</option>
            <option value="gst">GST invoice</option>
          </select>
        </Field>
      </div>
      {q ? (
        <p className="caption" style={{ marginTop: 0, marginBottom: "var(--space-3)" }}>
          Searching all dates.
        </p>
      ) : null}

      {bills.isPending ? <Loading /> : null}
      {bills.isError ? <Notice tone="bad">{errorText(bills.error)}</Notice> : null}
      {data ? (
        data.results.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Time</th>
                  <th>Customer</th>
                  <th>Counter · staff</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((b) => (
                  <tr
                    key={b.id}
                    className={`clickable ${b.status === "cancelled" ? "cancelled" : ""}`}
                    onClick={() => setOpenId(b.id)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setOpenId(b.id)}
                  >
                    <td>
                      <strong>{b.number}</strong>
                      {b.doc_type === "gst" ? <span className="muted small"> · GST</span> : null}
                    </td>
                    <td>{fmtDateTime(b.at)}</td>
                    <td>{[b.customer_name, b.customer_phone].filter(Boolean).join(" · ") || <span className="muted">Walk-in</span>}</td>
                    <td>
                      {b.counter_name} · {b.user_name}
                    </td>
                    <td className="num">{rs(b.total_paise)}</td>
                    <td>
                      {b.status === "cancelled" ? <Badge tone="bad">Cancelled</Badge> : <Badge tone="good">Active</Badge>}
                      {b.status === "active" && b.balance_paise > 0 ? <Badge tone="warn">Balance {rs(b.balance_paise)}</Badge> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No bills found">Change the dates or the search.</Empty>
        )
      ) : null}
      {data && data.results.length < data.count ? (
        <div className="row" style={{ justifyContent: "center", marginTop: "var(--space-4)" }}>
          <Button onClick={() => setLimit((n) => n + 50)} loading={bills.isFetching}>
            Show more ({data.count - data.results.length} left)
          </Button>
        </div>
      ) : null}
      <BillDialog id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Receipt, Search, Trash2 } from "lucide-react";
import { api, errorText, query } from "../lib/api";
import { addDays, fmtDate, fmtDateTime, isToday, todayIso } from "../lib/format";
import { rs, rsShort } from "../lib/money";
import { useProducts, useSession } from "../lib/session";
import { MODE_LABEL, PAYMENT_MODES, type Booking, type BookingSummary, type PaymentMode } from "../lib/types";
import { Badge, Button, Dialog, Empty, Field, IconButton, Loading, MoneyInput, Notice, PageHead, Segmented, useToast } from "../components/ui";
import ProductPicker from "../components/ProductPicker";
import { BillDialog } from "./BillsPage";

const FREE_DELIVERY_PAISE = 500000;

type EditLine = { product_id: number; sale_unit: "unit" | "case"; qty: number };

function statusBadge(b: BookingSummary) {
  if (b.status === "cancelled") return <Badge tone="bad">Cancelled</Badge>;
  if (b.status === "delivered") return <Badge tone="good">Delivered</Badge>;
  if (b.status === "ready") return <Badge tone="gold">Ready</Badge>;
  return <Badge>Booked</Badge>;
}

function dueBadge(b: BookingSummary) {
  if (b.status === "delivered" || b.status === "cancelled") return null;
  const today = todayIso();
  if (b.delivery_date < today) return <Badge tone="bad">Late</Badge>;
  if (isToday(b.delivery_date)) return <Badge tone="gold">Today</Badge>;
  if (b.delivery_date === addDays(today, 1)) return <Badge>Tomorrow</Badge>;
  return null;
}

function BookingEditor({ booking, onClose, onSaved }: { booking: Booking | null; onClose: () => void; onSaved: (b: Booking) => void }) {
  const products = useProducts();
  const { counterId } = useSession();
  const notify = useToast();
  const [name, setName] = useState(booking?.customer_name ?? "");
  const [phone, setPhone] = useState(booking?.customer_phone ?? "");
  const [address, setAddress] = useState(booking?.address ?? "");
  const [date, setDate] = useState(booking?.delivery_date ?? todayIso());
  const [note, setNote] = useState(booking?.note ?? "");
  const [lines, setLines] = useState<EditLine[]>(
    booking?.lines.map((l) => ({ product_id: l.product_id, sale_unit: l.sale_unit, qty: l.qty })) ?? [],
  );
  // When editing, the advance starts at what has been paid so far and can be corrected.
  const paidMode = booking?.payments.filter((p) => p.kind === "advance").slice(-1)[0]?.mode ?? "cash";
  const [advanceMode, setAdvanceMode] = useState<PaymentMode>(paidMode);
  const [advance, setAdvance] = useState<number | null>(booking ? booking.advance_paise : null);
  const advanceChanged = !!booking && ((advance ?? 0) !== booking.advance_paise || advanceMode !== paidMode);
  const returning = !!booking && (advance ?? 0) < booking.advance_paise;

  const map = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);
  const estimate = lines.reduce((sum, l) => {
    const p = map.get(l.product_id);
    return sum + (p ? p.price_paise * (l.sale_unit === "case" ? (p.units_per_case ?? 1) : 1) * l.qty : 0);
  }, 0);

  const save = useMutation({
    mutationFn: () => {
      const body = { customer_name: name, customer_phone: phone, address, delivery_date: date, note, lines };
      return booking
        ? api.patch<Booking>(`/api/bookings/${booking.id}`, {
            ...body,
            counter_id: counterId,
            advance: advanceChanged ? { mode: advanceMode, amount_paise: advance ?? 0 } : null,
          })
        : api.post<Booking>("/api/bookings", {
            ...body,
            counter_id: counterId,
            advance: advance ? { mode: advanceMode, amount_paise: advance } : null,
          });
    },
    onSuccess: (saved) => {
      notify(saved.advance_note ?? (booking ? `Booking ${saved.number} updated.` : `Booking ${saved.number} saved.`));
      onSaved(saved);
    },
    onError: (error) => notify(errorText(error), "bad"),
  });

  const ready = name.trim().length > 1 && /^[6-9]\d{9}$/.test(phone.replace(/\D/g, "").slice(-10)) && date && lines.length > 0;

  return (
    <Dialog
      open
      wide
      title={booking ? `Edit booking ${booking.number}` : "New booking"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>
            {booking ? "Save changes" : "Save booking"}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label="Customer name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Phone">
            <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Delivery or pick-up date">
            <input className="input" type="date" value={date} min={booking ? undefined : todayIso()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Address" hint="Needed when we deliver.">
          <textarea className="textarea" rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>

        <div>
          <div className="section-head">
            <h3>Items</h3>
            <span className="num" style={{ fontWeight: 700 }}>
              {rs(estimate)}
            </span>
          </div>
          <ProductPicker
            products={products.data ?? []}
            exclude={lines.map((l) => l.product_id)}
            onPick={(p) => setLines((ls) => [...ls, { product_id: p.id, sale_unit: "unit", qty: 1 }])}
          />
          {lines.length ? (
            <div className="table-wrap" style={{ marginTop: "var(--space-3)" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty</th>
                    <th className="num">Amount</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => {
                    const p = map.get(line.product_id);
                    const factor = line.sale_unit === "case" ? (p?.units_per_case ?? 1) : 1;
                    return (
                      <tr key={line.product_id}>
                        <td>{p?.name ?? "Item no longer sold"}</td>
                        <td>
                          <div className="row" style={{ gap: "var(--space-2)", flexWrap: "nowrap" }}>
                            <input
                              className="input"
                              style={{ width: 72 }}
                              inputMode="numeric"
                              aria-label="Quantity"
                              value={line.qty}
                              onChange={(e) => {
                                const qty = Number(e.target.value.replace(/\D/g, "").slice(0, 5));
                                setLines((ls) => ls.map((l, i) => (i === index ? { ...l, qty: Math.max(qty, 1) } : l)));
                              }}
                            />
                            {p?.units_per_case ? (
                              <select
                                className="select"
                                style={{ width: 96 }}
                                aria-label="Unit"
                                value={line.sale_unit}
                                onChange={(e) =>
                                  setLines((ls) => ls.map((l, i) => (i === index ? { ...l, sale_unit: e.target.value as "unit" | "case" } : l)))
                                }
                              >
                                <option value="unit">{p.unit_name}</option>
                                <option value="case">Bundle</option>
                              </select>
                            ) : (
                              <span className="muted small">{p?.unit_name}</span>
                            )}
                          </div>
                        </td>
                        <td className="num">{rs((p?.price_paise ?? 0) * factor * line.qty)}</td>
                        <td>
                          <IconButton label="Remove item" onClick={() => setLines((ls) => ls.filter((_, i) => i !== index))}>
                            <Trash2 size={16} />
                          </IconButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="caption">Search above to add items.</p>
          )}
          <p className="caption">
            {estimate >= FREE_DELIVERY_PAISE
              ? "This order gets free delivery (above ₹5,000)."
              : `Free delivery above ₹5,000. Add ${rs(FREE_DELIVERY_PAISE - estimate)} more for free delivery.`}{" "}
            Prices are worked out again when the bill is made.
          </p>
        </div>

        <div className="form-grid">
          <Field
            label={booking ? "Advance paid" : "Advance paid now"}
            hint={
              booking
                ? "Correct it here if it was entered wrong. For an advance from a day already closed, the difference is recorded today."
                : "Leave empty if no advance."
            }
          >
            <MoneyInput value={advance} onChange={setAdvance} />
          </Field>
          <Field label={returning ? "Returned to the customer by" : "Paid by"}>
            <select className="select" value={advanceMode} onChange={(e) => setAdvanceMode(e.target.value as PaymentMode)}>
              {PAYMENT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Note">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </Field>
      </div>
    </Dialog>
  );
}

function BookingDialog({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (b: Booking) => void }) {
  const { isOwner, counterId } = useSession();
  const client = useQueryClient();
  const notify = useToast();
  const navigate = useNavigate();
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [amount, setAmount] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [refundMode, setRefundMode] = useState<PaymentMode>("cash");
  const [billId, setBillId] = useState<number | null>(null);
  const booking = useQuery({ queryKey: ["booking", id], queryFn: () => api.get<Booking>(`/api/bookings/${id}`) });

  const refresh = (updated: Booking) => {
    client.setQueryData(["booking", id], updated);
    void client.invalidateQueries({ queryKey: ["bookings"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const addAdvance = useMutation({
    mutationFn: () => api.post<Booking>(`/api/bookings/${id}/payments`, { mode, amount_paise: amount, counter_id: counterId }),
    onSuccess: (updated) => {
      refresh(updated);
      setAmount(null);
      notify("Advance recorded.");
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  const setStatus = useMutation({
    mutationFn: (status: "booked" | "ready") => api.patch<Booking>(`/api/bookings/${id}`, { status }),
    onSuccess: refresh,
    onError: (error) => notify(errorText(error), "bad"),
  });
  const cancel = useMutation({
    mutationFn: () => api.post<Booking>(`/api/bookings/${id}/cancel`, { reason, refund_mode: refundMode }),
    onSuccess: (updated) => {
      refresh(updated);
      setCancelling(false);
      notify(`Booking ${updated.number} cancelled.`);
    },
    onError: (error) => notify(errorText(error), "bad"),
  });

  const b = booking.data;
  const open = b && (b.status === "booked" || b.status === "ready");
  return (
    <>
      <Dialog
        open={!cancelling && billId === null}
        wide
        title={b ? `Booking ${b.number}` : "Booking"}
        onClose={onClose}
        footer={
          b ? (
            <>
              {isOwner && open ? (
                <Button variant="danger" onClick={() => setCancelling(true)}>
                  Cancel booking
                </Button>
              ) : null}
              <span style={{ flex: 1 }} />
              {open ? <Button onClick={() => onEdit(b)}>Edit</Button> : null}
              {open ? (
                <Button onClick={() => setStatus.mutate(b.status === "ready" ? "booked" : "ready")} loading={setStatus.isPending}>
                  {b.status === "ready" ? "Mark not ready" : "Mark ready"}
                </Button>
              ) : null}
              {open ? (
                <Button variant="primary" onClick={() => navigate(`/billing?booking=${b.id}`)}>
                  <Receipt size={16} aria-hidden /> Bill now
                </Button>
              ) : null}
              {b.bill ? (
                <Button variant="primary" onClick={() => setBillId(b.bill!.id)}>
                  Open bill {b.bill.number}
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {booking.isPending ? <Loading /> : null}
        {booking.isError ? <Notice tone="bad">{errorText(booking.error)}</Notice> : null}
        {b ? (
          <div className="stack">
            <div className="row">
              {statusBadge(b)}
              {dueBadge(b)}
              <span className="muted small">Due {fmtDate(b.delivery_date)}</span>
            </div>
            <div className="split">
              <dl className="kv">
                <dt>Customer</dt>
                <dd>{b.customer_name}</dd>
                <dt>Phone</dt>
                <dd>{b.customer_phone}</dd>
                {b.address ? (
                  <>
                    <dt>Address</dt>
                    <dd style={{ whiteSpace: "pre-line" }}>{b.address}</dd>
                  </>
                ) : null}
                {b.note ? (
                  <>
                    <dt>Note</dt>
                    <dd>{b.note}</dd>
                  </>
                ) : null}
                {b.cancelled_reason ? (
                  <>
                    <dt>Cancelled</dt>
                    <dd>{b.cancelled_reason}</dd>
                  </>
                ) : null}
              </dl>
              <dl className="kv">
                <dt>Items (today's prices)</dt>
                <dd>{rs(b.estimate_paise)}</dd>
                <dt>Advance paid</dt>
                <dd>{rs(b.advance_paise)}</dd>
                <dt>Balance (before discount)</dt>
                <dd>{rs(Math.max(b.estimate_paise - b.advance_paise, 0))}</dd>
              </dl>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {b.lines.map((l) => {
                    const factor = l.sale_unit === "case" ? (l.units_per_case ?? 1) : 1;
                    return (
                      <tr key={`${l.product_id}${l.sale_unit}`}>
                        <td>
                          {l.name} <span className="muted small">{l.code}</span>
                        </td>
                        <td className="num">
                          {l.qty} {l.sale_unit === "case" ? "Bundle" : l.unit_name}
                        </td>
                        <td className="num">{rs(l.price_paise * factor * l.qty)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {b.payments.length ? (
              <section>
                <h3 style={{ marginBottom: "var(--space-2)" }}>Advance payments</h3>
                <ul className="list">
                  {b.payments.map((p) => (
                    <li key={p.id}>
                      <span className="grow">
                        {p.kind === "refund" ? "Returned" : "Paid"} by {MODE_LABEL[p.mode]} · {fmtDateTime(p.at)}
                      </span>
                      <span className="num">{rs(p.amount_paise)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {open ? (
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <Field label="Add advance">
                  <MoneyInput value={amount} onChange={setAmount} />
                </Field>
                <Field label="Paid by">
                  <select className="select" value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
                    {PAYMENT_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button onClick={() => addAdvance.mutate()} disabled={!amount || amount <= 0} loading={addAdvance.isPending}>
                  Record advance
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={cancelling}
        title={`Cancel booking ${b?.number ?? ""}`}
        onClose={() => setCancelling(false)}
        footer={
          <>
            <Button onClick={() => setCancelling(false)}>Keep booking</Button>
            <Button variant="danger" disabled={reason.trim().length < 3} loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel booking
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="Why is it cancelled?">
            <textarea className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
          {b && b.advance_paise > 0 ? (
            <Field label={`Return the advance of ${rs(b.advance_paise)} by`}>
              <select className="select" value={refundMode} onChange={(e) => setRefundMode(e.target.value as PaymentMode)}>
                {PAYMENT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      </Dialog>
      <BillDialog id={billId} onClose={() => setBillId(null)} />
    </>
  );
}

export default function BookingsPage() {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const [status, setStatus] = useState<string>("open");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(params.get("new") === "1");
  const [editing, setEditing] = useState<Booking | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    if (params.get("new")) setParams({}, { replace: true });
  }, [params, setParams]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const list = useQuery({
    queryKey: ["bookings", status, q],
    queryFn: () => api.get<BookingSummary[]>(`/api/bookings${query({ status, q })}`),
    placeholderData: keepPreviousData,
  });

  const saved = (booking: Booking) => {
    setCreating(false);
    setEditing(null);
    client.setQueryData(["booking", booking.id], booking);
    void client.invalidateQueries({ queryKey: ["bookings"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
    setOpenId(booking.id);
  };

  const rows = list.data ?? [];
  return (
    <div className="page">
      <PageHead
        title="Bookings"
        subtitle="Pre-orders for corporate gifts and big Diwali orders. Delivery is free above ₹5,000."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <CalendarPlus size={16} aria-hidden /> New booking
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented
          label="Booking status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "open", label: "Open" },
            { value: "delivered", label: "Delivered" },
            { value: "cancelled", label: "Cancelled" },
            { value: "", label: "All" },
          ]}
        />
        <div className="search" style={{ flex: "1 1 240px" }}>
          <Search size={16} aria-hidden />
          <input className="input" placeholder="Name, phone or booking number" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {list.isPending ? <Loading /> : null}
      {list.isError ? <Notice tone="bad">{errorText(list.error)}</Notice> : null}
      {list.data ? (
        rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Customer</th>
                  <th>Due</th>
                  <th className="num">Items</th>
                  <th className="num">Advance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} className="clickable" tabIndex={0} onClick={() => setOpenId(b.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(b.id)}>
                    <td>
                      <strong>{b.number}</strong>
                    </td>
                    <td>
                      {b.customer_name} <span className="muted small">{b.customer_phone}</span>
                    </td>
                    <td>
                      <span className="row" style={{ gap: "var(--space-2)" }}>
                        {fmtDate(b.delivery_date)} {dueBadge(b)}
                      </span>
                    </td>
                    <td className="num">{rsShort(b.estimate_paise)}</td>
                    <td className="num">{rsShort(b.advance_paise)}</td>
                    <td>{statusBadge(b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={status === "open" ? "No open bookings" : "No bookings here"}>Press New booking to take a pre-order.</Empty>
        )
      ) : null}
      {creating ? <BookingEditor booking={null} onClose={() => setCreating(false)} onSaved={saved} /> : null}
      {editing ? <BookingEditor booking={editing} onClose={() => setEditing(null)} onSaved={saved} /> : null}
      {openId !== null && !editing ? (
        <BookingDialog
          id={openId}
          onClose={() => setOpenId(null)}
          onEdit={(b) => {
            setEditing(b);
          }}
        />
      ) : null}
    </div>
  );
}

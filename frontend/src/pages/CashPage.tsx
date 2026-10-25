import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Trash2 } from "lucide-react";
import { api, errorText } from "../lib/api";
import { fmtDate, fmtTime, todayIso } from "../lib/format";
import { rs } from "../lib/money";
import { useSession, useSettings } from "../lib/session";
import { PAYMENT_MODES, type DaySummary, type Expense } from "../lib/types";
import { isValidPhone, openWhatsApp } from "../lib/whatsapp";
import { Badge, Button, Dialog, Empty, Field, IconButton, Loading, MoneyInput, Notice, PageHead, useToast } from "../components/ui";

const CATEGORIES = [
  { value: "electricity", label: "Electricity" },
  { value: "tea", label: "Tea" },
  { value: "labour", label: "Labour" },
  { value: "food", label: "Food" },
  { value: "transport", label: "Transport" },
  { value: "other", label: "Other" },
];

function summaryText(shopName: string, s: DaySummary): string {
  const used = PAYMENT_MODES.filter((m) => m.value === "cash" || (s.payments_by_mode[m.value] ?? 0) !== 0);
  const modes = used.map((m) => `${m.label} ${rs(s.payments_by_mode[m.value] ?? 0)}`).join("\n");
  const bills = `${s.sales_count} ${s.sales_count === 1 ? "bill" : "bills"}`;
  return [
    `*${shopName}*`,
    `Day closing · ${fmtDate(s.business_date)}`,
    "",
    `Sales: ${rs(s.sales_total_paise)} (${bills}${s.cancelled_count ? `, ${s.cancelled_count} cancelled` : ""})`,
    `Discount given: ${rs(s.discount_total_paise)}`,
    "",
    "Money collected:",
    modes,
    "",
    `Expenses: ${rs(s.expenses_total_paise)}`,
    `Opening cash: ${rs(s.opening_cash_paise)}`,
    `Expected cash: ${rs(s.expected_cash_paise)}`,
    s.counted_cash_paise !== null ? `Counted cash: ${rs(s.counted_cash_paise)}` : null,
    s.difference_paise !== null ? `Difference: ${rs(s.difference_paise)}` : null,
    s.handed_over_paise !== null ? `Handed over to owner: ${rs(s.handed_over_paise)}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export default function CashPage() {
  const { isOwner, boot } = useSession();
  const settings = useSettings();
  const client = useQueryClient();
  const notify = useToast();
  const [day, setDay] = useState(todayIso());
  const [opening, setOpening] = useState<number | null>(null);
  const [counted, setCounted] = useState<number | null>(null);
  const [handed, setHanded] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("tea");
  const [amount, setAmount] = useState<number | null>(null);
  const [expenseNote, setExpenseNote] = useState("");
  const [fromDrawer, setFromDrawer] = useState(true);
  const [askPhone, setAskPhone] = useState(false);
  const [phone, setPhone] = useState("");
  const isTodayView = day === todayIso();

  const summary = useQuery({ queryKey: ["day", day], queryFn: () => api.get<DaySummary>(`/api/day?date=${day}`) });
  const expenses = useQuery({ queryKey: ["expenses", day], queryFn: () => api.get<Expense[]>(`/api/expenses?date=${day}`) });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["day", day] });
    void client.invalidateQueries({ queryKey: ["expenses", day] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const openDay = useMutation({
    mutationFn: () => api.post<DaySummary>("/api/day/open", { opening_cash_paise: opening ?? 0 }),
    onSuccess: () => {
      notify("Day opened.");
      refresh();
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  const closeDay = useMutation({
    mutationFn: () =>
      api.post<DaySummary & { backup?: { drive_error?: string | null; error?: string } }>("/api/day/close", {
        counted_cash_paise: counted,
        handed_over_paise: handed,
        note,
      }),
    onSuccess: (result) => {
      notify("Day closed and backed up.");
      if (result.backup?.error || result.backup?.drive_error) {
        notify(`Backup problem: ${result.backup.error ?? result.backup.drive_error}`, "bad");
      }
      refresh();
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  const addExpense = useMutation({
    mutationFn: () =>
      api.post<Expense>("/api/expenses", {
        category,
        amount_paise: amount,
        note: expenseNote,
        paid_from_drawer: fromDrawer,
        business_date: day,
      }),
    onSuccess: () => {
      setAmount(null);
      setExpenseNote("");
      notify("Expense added.");
      refresh();
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  const removeExpense = useMutation({
    mutationFn: (id: number) => api.del(`/api/expenses/${id}`),
    onSuccess: () => {
      notify("Expense removed.");
      refresh();
    },
    onError: (error) => notify(errorText(error), "bad"),
  });

  const s = summary.data;
  const difference = s && counted !== null ? counted - s.expected_cash_paise : null;

  function sendSummary(number: string) {
    if (!s) return;
    openWhatsApp(number, summaryText(boot.shop_name, s));
    setAskPhone(false);
  }

  return (
    <div className="page">
      <PageHead
        title="Expenses & day closing"
        subtitle={isTodayView ? `Today, ${fmtDate(day)}` : fmtDate(day)}
        actions={
          <Field label="Day">
            <input className="input" type="date" value={day} max={todayIso()} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </Field>
        }
      />
      {summary.isPending ? <Loading /> : null}
      {summary.isError ? <Notice tone="bad">{errorText(summary.error)}</Notice> : null}
      {s ? (
        <div className="split">
          <section className="stack">
            <div className="section-head">
              <h2>Cash in the drawer</h2>
              {s.closed ? <Badge tone="good">Closed</Badge> : s.opened ? <Badge tone="gold">Open</Badge> : <Badge>Not opened</Badge>}
            </div>
            <dl className="kv">
              <dt>Opening cash</dt>
              <dd>{s.opening_cash_paise === null ? "Not entered" : rs(s.opening_cash_paise)}</dd>
              <dt>Cash from bills</dt>
              <dd>{rs(s.cash_sales_paise)}</dd>
              <dt>Cash advances (bookings)</dt>
              <dd>{rs(s.cash_advances_paise)}</dd>
              <dt>Cash returned (cancelled)</dt>
              <dd>{rs(s.cash_refunds_paise)}</dd>
              <dt>Expenses paid from drawer</dt>
              <dd>−{rs(s.expenses_from_drawer_paise)}</dd>
              <dt style={{ fontWeight: 700, color: "var(--color-ink)" }}>Expected cash now</dt>
              <dd style={{ fontSize: "var(--text-md)" }}>{rs(s.expected_cash_paise)}</dd>
              {s.closed ? (
                <>
                  <dt>Counted at closing</dt>
                  <dd>{rs(s.counted_cash_paise)}</dd>
                  <dt>Difference</dt>
                  <dd style={{ color: s.difference_paise ? "var(--color-bad)" : "var(--color-good)" }}>{rs(s.difference_paise)}</dd>
                  <dt>Handed over to owner</dt>
                  <dd>{rs(s.handed_over_paise)}</dd>
                  <dt>Closed by</dt>
                  <dd>
                    {s.closed_by} at {fmtTime(s.closed_at)}
                  </dd>
                </>
              ) : null}
            </dl>

            {isTodayView && !s.opened ? (
              <div className="panel stack">
                <h3>Open the day</h3>
                <Field label="Cash in the drawer now" hint="Count the cash before the first bill.">
                  <MoneyInput value={opening} onChange={setOpening} autoFocus />
                </Field>
                <Button variant="primary" onClick={() => openDay.mutate()} loading={openDay.isPending} disabled={opening === null}>
                  Open the day
                </Button>
              </div>
            ) : null}

            {isTodayView && s.opened && !s.closed ? (
              <div className="panel stack">
                <h3>Close the day</h3>
                <Field label="Cash counted in the drawer">
                  <MoneyInput value={counted} onChange={setCounted} />
                </Field>
                {difference !== null ? (
                  difference === 0 ? (
                    <Notice tone="good">Cash matches exactly.</Notice>
                  ) : (
                    <Notice tone="warn">
                      {difference > 0 ? `${rs(difference)} more than expected.` : `${rs(-difference)} short.`} Add a note
                      explaining it.
                    </Notice>
                  )
                ) : null}
                <Field label="Cash handed over to the owner" hint="Optional. The rest stays in the drawer.">
                  <MoneyInput value={handed} onChange={setHanded} />
                </Field>
                <Field label="Note">
                  <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
                </Field>
                <Button variant="primary" onClick={() => closeDay.mutate()} loading={closeDay.isPending} disabled={counted === null}>
                  Close the day
                </Button>
                <p className="caption">Closing also makes a backup.</p>
              </div>
            ) : null}

            {s.closed || !isTodayView ? (
              <Button
                onClick={() => {
                  const owner = settings.data?.owner_whatsapp ?? "";
                  if (isValidPhone(owner)) sendSummary(owner);
                  else setAskPhone(true);
                }}
              >
                <MessageCircle size={16} aria-hidden /> Send summary on WhatsApp
              </Button>
            ) : null}
          </section>

          <section className="stack">
            <div className="section-head">
              <h2>Sales</h2>
              <span className="num" style={{ fontWeight: 700 }}>
                {rs(s.sales_total_paise)}
              </span>
            </div>
            <dl className="kv">
              <dt>Bills</dt>
              <dd>
                {s.sales_count}
                {s.cancelled_count ? ` (+${s.cancelled_count} cancelled)` : ""}
              </dd>
              <dt>Discount given</dt>
              <dd>{rs(s.discount_total_paise)}</dd>
              {PAYMENT_MODES.map((m) => (
                <Row key={m.value} label={m.label} value={rs(s.payments_by_mode[m.value] ?? 0)} />
              ))}
            </dl>

            <div className="section-head" style={{ marginTop: "var(--space-4)" }}>
              <h2>Expenses</h2>
              <span className="num" style={{ fontWeight: 700 }}>
                {rs(s.expenses_total_paise)}
              </span>
            </div>
            {(isTodayView || isOwner) && !s.closed ? (
              <div className="panel stack">
                <div className="form-grid">
                  <Field label="For">
                    <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Amount">
                    <MoneyInput value={amount} onChange={setAmount} />
                  </Field>
                </div>
                <Field label="Note">
                  <input className="input" value={expenseNote} onChange={(e) => setExpenseNote(e.target.value)} placeholder="Optional" />
                </Field>
                <label className="check">
                  <input type="checkbox" checked={fromDrawer} onChange={(e) => setFromDrawer(e.target.checked)} />
                  Paid from the cash drawer
                </label>
                <Button onClick={() => addExpense.mutate()} loading={addExpense.isPending} disabled={!amount || amount <= 0}>
                  Add expense
                </Button>
              </div>
            ) : null}
            {expenses.data?.length ? (
              <ul className="list">
                {expenses.data.map((e) => (
                  <li key={e.id}>
                    <span className="grow">
                      <strong>{e.category_label}</strong>
                      {e.note ? ` · ${e.note}` : ""}
                      <span className="muted small"> · {e.user}, {fmtTime(e.at)}{e.paid_from_drawer ? "" : " · not from drawer"}</span>
                    </span>
                    <span className="num">{rs(e.amount_paise)}</span>
                    {isOwner && !s.closed ? (
                      <IconButton label="Remove expense" onClick={() => removeExpense.mutate(e.id)} disabled={removeExpense.isPending}>
                        <Trash2 size={16} />
                      </IconButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : expenses.data ? (
              <Empty title="No expenses on this day" />
            ) : null}
          </section>
        </div>
      ) : null}
      <Dialog
        open={askPhone}
        title="Send day summary"
        onClose={() => setAskPhone(false)}
        footer={
          <>
            <Button onClick={() => setAskPhone(false)}>Cancel</Button>
            <Button variant="primary" disabled={!isValidPhone(phone)} onClick={() => sendSummary(phone)}>
              Open WhatsApp
            </Button>
          </>
        }
      >
        <Field label="Owner's WhatsApp number" hint="Save it in Settings to skip this step next time.">
          <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus />
        </Field>
      </Dialog>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

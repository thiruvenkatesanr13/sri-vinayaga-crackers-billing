import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, CalendarClock, HardDrive, Receipt, RefreshCw, Wallet } from "lucide-react";
import { api, errorText, query } from "../lib/api";
import { addDays, fmtDate, fmtDateTime, fmtMonth, fmtShortDate, fmtTime, fmtWeekday, isToday, todayIso } from "../lib/format";
import { pct, rs, rsShort } from "../lib/money";
import { useSession } from "../lib/session";
import { PAYMENT_MODES, type BackupStatus, type Dashboard, type DashboardStats } from "../lib/types";
import { Badge, Button, Empty, Field, Loading, Notice, PageHead, Segmented, useToast } from "../components/ui";

const MIX_COLORS: Record<string, string> = {
  cash: "var(--color-mix-cash)",
  upi: "var(--color-mix-upi)",
  card: "var(--color-mix-card)",
  credit_card: "var(--color-mix-credit)",
  bank: "var(--color-mix-bank)",
};

function compact(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(rupees >= 1000000 ? 0 : 1)}L`;
  if (rupees >= 1000) return `₹${(rupees / 1000).toFixed(rupees >= 10000 ? 0 : 1)}K`;
  return `₹${Math.round(rupees)}`;
}

const TICK_MS = 1200; // same as --dur-tick

/** Hum's tick-up: the sales figure counts up once when the dashboard opens. Instant with reduced motion. */
function TickUp({ paise }: { paise: number }) {
  const reduce = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [shown, setShown] = useState(reduce ? paise : 0);
  const played = useRef(reduce);

  useEffect(() => {
    if (played.current) {
      setShown(paise);
      return;
    }
    played.current = true;
    let done = false;
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / TICK_MS);
      const eased = 1 - (1 - t) ** 4;
      // Whole rupees while counting, so the figure does not flicker with paise.
      setShown(t < 1 ? Math.round((paise / 100) * eased) * 100 : paise);
      if (t < 1) frame = requestAnimationFrame(step);
      else done = true;
    });
    return () => {
      cancelAnimationFrame(frame);
      if (!done) played.current = false;
    };
  }, [paise]);

  return <>{rsShort(shown)}</>;
}

type Preset = "today" | "yesterday" | "7" | "30" | "custom";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "custom", label: "Pick dates" },
];

function presetRange(preset: Preset, custom: { from: string; to: string }) {
  const today = todayIso();
  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") return { from: addDays(today, -1), to: addDays(today, -1) };
  if (preset === "7") return { from: addDays(today, -6), to: today };
  if (preset === "30") return { from: addDays(today, -29), to: today };
  return custom;
}

/** "today" or "yesterday" when the dates are just that day, for labels like "Expenses today". */
function dayWord(from: string, to: string): "today" | "yesterday" | null {
  if (from !== to) return null;
  if (from === todayIso()) return "today";
  if (from === addDays(todayIso(), -1)) return "yesterday";
  return null;
}

function titleFor(preset: Preset, from: string, to: string): string {
  const word = dayWord(from, to);
  if (word) return word === "today" ? "Today" : "Yesterday";
  if (preset === "7") return "Last 7 days";
  if (preset === "30") return "Last 30 days";
  return from === to ? fmtDate(from) : `${fmtShortDate(from)} – ${fmtShortDate(to)}`;
}

function spanText(from: string, to: string): string {
  return from === to ? fmtDate(from) : `${fmtShortDate(from)} – ${fmtDate(to)}`;
}

function PaymentMix({ stats, title }: { stats: DashboardStats; title: string }) {
  const entries = PAYMENT_MODES.map((m) => ({ ...m, amount: stats.payments_by_mode[m.value] ?? 0 }));
  const positive = entries.filter((e) => e.amount > 0);
  const total = positive.reduce((sum, e) => sum + e.amount, 0);
  return (
    <section>
      <div className="section-head">
        <h2>{title}</h2>
        <span className="num" style={{ fontWeight: 700 }}>
          {rs(entries.reduce((s, e) => s + e.amount, 0))}
        </span>
      </div>
      {total > 0 ? (
        <div className="mix" role="img" aria-label="Share of money collected by payment mode">
          {positive.map((e) => (
            <span key={e.value} style={{ width: `${(e.amount / total) * 100}%`, background: MIX_COLORS[e.value] }} />
          ))}
        </div>
      ) : null}
      <div className="mix-legend">
        {entries
          .filter((e) => e.amount !== 0 || e.value === "cash")
          .map((e) => (
            <div key={e.value}>
              <span className="swatch" style={{ background: MIX_COLORS[e.value] }} aria-hidden />
              <span>{e.label}</span>
              <span className="amount">{rsShort(e.amount)}</span>
            </div>
          ))}
      </div>
      <p className="caption">Includes booking advances. Money returned for cancelled bills is taken off.</p>
    </section>
  );
}

function SalesBars({ chart, single }: { chart: DashboardStats["chart"]; single: boolean }) {
  const points = chart.points;
  const today = todayIso();
  const max = Math.max(1, ...points.map((p) => p.total_paise));
  const dense = points.length > 14;
  const step = dense ? Math.ceil(points.length / 8) : 1;
  const title = single
    ? chart.to === today
      ? "Sales, last 7 days"
      : `Sales, 7 days to ${fmtShortDate(chart.to)}`
    : `Sales by ${chart.unit}`;
  const label = (date: string) =>
    chart.unit === "month"
      ? fmtMonth(date)
      : chart.unit === "week" || dense
        ? fmtShortDate(date)
        : `${fmtWeekday(date)} ${fmtShortDate(date).split(" ")[0]}`;
  const span = (p: { date: string; to: string }) => (p.date === p.to ? fmtDate(p.date) : `${fmtShortDate(p.date)} – ${fmtDate(p.to)}`);
  return (
    <section>
      <div className="section-head">
        <h2>{title}</h2>
      </div>
      <div className={`bars ${dense ? "dense" : ""}`} style={{ "--bar-count": points.length } as CSSProperties}>
        <div className="bars-y">Sales (₹)</div>
        <div>
          <div className="bars-plot" role="img" aria-label={`Net sales for each ${chart.unit} from ${fmtDate(chart.from)} to ${fmtDate(chart.to)}`}>
            {points.map((p) => (
              <div
                key={p.date}
                className={`bar ${today >= p.date && today <= p.to ? "today" : ""}`}
                style={{ height: `${Math.max(1.5, (p.total_paise / max) * 100)}%` }}
                title={`${span(p)}: ${rs(p.total_paise)} from ${p.bills} bill${p.bills === 1 ? "" : "s"}`}
              >
                {!dense && p.total_paise > 0 ? <span className="tip">{compact(p.total_paise)}</span> : null}
              </div>
            ))}
          </div>
          <div className="bars-x" aria-hidden>
            {points.map((p, i) => (
              <span key={p.date}>{i % step === 0 ? label(p.date) : ""}</span>
            ))}
          </div>
        </div>
      </div>
      <p className="caption">Net sales after discount. Cancelled bills are not counted.</p>
    </section>
  );
}

export default function DashboardPage() {
  const { isOwner } = useSession();
  const notify = useToast();
  const client = useQueryClient();
  const [preset, setPreset] = useState<Preset>("today");
  const [custom, setCustom] = useState(() => ({ from: addDays(todayIso(), -6), to: todayIso() }));
  const range = presetRange(preset, custom);
  const params = { from: range.from, to: range.to };

  const dashboard = useQuery({
    queryKey: ["dashboard", params],
    queryFn: () => api.get<Dashboard>(`/api/dashboard${query(params)}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const result = await dashboard.refetch();
      if (result.error) throw result.error;
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  const backupNow = useMutation({
    mutationFn: () => api.post<{ status: BackupStatus }>("/api/backups"),
    onSuccess: ({ status }) => {
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      void client.invalidateQueries({ queryKey: ["backups"] });
      if (status.drive_error) notify(`Saved on this PC. Google Drive copy failed: ${status.drive_error}`, "bad");
      else notify(status.drive_configured ? "Backed up to this PC and Google Drive." : "Backed up to this PC.");
    },
    onError: (error) => notify(errorText(error), "bad"),
  });

  if (dashboard.isPending) return <div className="page"><Loading /></div>;
  const data = dashboard.data;
  if (!data) {
    return (
      <div className="page">
        <Notice tone="bad">{errorText(dashboard.error)}</Notice>
      </div>
    );
  }

  const stats = data.stats;
  const word = dayWord(data.period.from, data.period.to);
  const when = (base: string) => (word ? `${base} ${word}` : base);
  const backup = data.backup;
  const backupToday = backup?.last_local_at && isToday(backup.last_local_at);
  const alerts = stats.stock_alerts;

  return (
    <div className="page">
      <PageHead
        title={titleFor(preset, range.from, range.to)}
        subtitle={spanText(range.from, range.to)}
        actions={
          <Button onClick={() => refresh.mutate()} loading={refresh.isPending}>
            <RefreshCw size={16} aria-hidden />
            Refresh
          </Button>
        }
      />

      <div className="toolbar">
        <div className="field">
          <span>Dates</span>
          <Segmented label="Dates" value={preset} onChange={setPreset} options={PRESETS} />
        </div>
        {preset === "custom" ? (
          <>
            <Field label="From">
              <input
                className="input"
                type="date"
                value={custom.from}
                max={custom.to}
                onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))}
              />
            </Field>
            <Field label="To">
              <input
                className="input"
                type="date"
                value={custom.to}
                min={custom.from}
                max={todayIso()}
                onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))}
              />
            </Field>
          </>
        ) : null}
      </div>

      {dashboard.isError ? <Notice tone="bad">{errorText(dashboard.error)}</Notice> : null}

      <div className={`dash-body ${dashboard.isPlaceholderData ? "is-loading" : ""}`} aria-busy={dashboard.isPlaceholderData}>
        <div className="stat-strip">
          <div className="stat hero">
            <div className="label">{word === "today" ? "Today's sales" : word === "yesterday" ? "Yesterday's sales" : "Sales"}</div>
            <div className="value">
              <TickUp paise={stats.sales_total_paise} />
            </div>
            <div className="sub">
              {stats.bills} bill{stats.bills === 1 ? "" : "s"}
              {stats.cancelled_bills ? ` · ${stats.cancelled_bills} cancelled` : ""}
            </div>
          </div>
          <div className="stat">
            <div className="label">Average bill</div>
            <div className="value">{rsShort(stats.average_bill_paise)}</div>
          </div>
          <div className="stat">
            <div className="label">Discount given</div>
            <div className="value">{rsShort(stats.discount_total_paise)}</div>
            {stats.sales_total_paise ? (
              <div className="sub">
                {pct(Math.round((stats.discount_total_paise * 10000) / (stats.sales_total_paise + stats.discount_total_paise)))} of
                items total
              </div>
            ) : null}
          </div>
          {stats.profit ? (
            <div className="stat">
              <div className="label">Profit (owner only)</div>
              <div className="value">{rsShort(stats.profit.profit_paise)}</div>
              <div className="sub">
                {stats.profit.bills_without_cost
                  ? `${stats.profit.bills_without_cost} ${stats.profit.bills_without_cost === 1 ? "bill" : "bills"} left out: no cost price yet`
                  : "Sales after discount, before GST, minus cost"}
              </div>
            </div>
          ) : (
            <div className="stat">
              <div className="label">Bills on hold</div>
              <div className="value">{stats.held_bills}</div>
            </div>
          )}
          <div className="stat">
            <div className="label">{when("Expenses")}</div>
            <div className="value">{rsShort(stats.expenses_paise)}</div>
          </div>
        </div>

        <div className="dash-grid">
          <div className="stack" style={{ gap: "var(--space-8)" }}>
            <PaymentMix stats={stats} title={when("Money collected")} />
            <SalesBars chart={stats.chart} single={data.period.days === 1} />
            <section>
              <div className="section-head">
                <h2>{when("Best sellers")}</h2>
              </div>
              {stats.top_products.length ? (
                <ul className="list">
                  {stats.top_products.map((p) => (
                    <li key={`${p.code}${p.name}`}>
                      <span className="muted" style={{ width: 56 }}>
                        {p.code}
                      </span>
                      <span className="grow">{p.name}</span>
                      <span className="num muted">
                        {p.qty} {p.unit}
                      </span>
                      <span className="num" style={{ fontWeight: 700, minWidth: 84 }}>
                        {rsShort(p.amount_paise)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title={word === "today" ? "No sales yet today" : word === "yesterday" ? "No sales yesterday" : "No sales on these dates"}>
                  {word === "today" ? "Bills made today show up here." : null}
                </Empty>
              )}
            </section>
          </div>

          <div className="stack" style={{ gap: "var(--space-8)" }}>
            <section>
              <div className="section-head">
                <h2>Quick actions</h2>
                {stats.held_bills ? <Badge tone="gold">{stats.held_bills} bill(s) on hold</Badge> : null}
              </div>
              <div className="quick">
                <Link className="btn primary lg" to="/billing">
                  <Receipt size={18} aria-hidden />
                  New bill
                </Link>
                <Link className="btn lg" to="/bookings?new=1">
                  <CalendarClock size={18} aria-hidden />
                  New booking
                </Link>
                <Link className="btn lg" to="/stock?tab=move">
                  <ArrowRightLeft size={18} aria-hidden />
                  Move stock
                </Link>
                <Link className="btn lg" to="/cash">
                  <Wallet size={18} aria-hidden />
                  Day closing
                </Link>
              </div>
            </section>

            <section className="tint-cyan">
              <div className="section-head">
                <h2>Bookings due</h2>
                <Link to="/bookings" className="small">
                  All bookings
                </Link>
              </div>
              {stats.bookings_due.length ? (
                <ul className="list">
                  {stats.bookings_due.slice(0, 8).map((b) => (
                    <li key={b.number}>
                      {b.overdue ? <Badge tone="bad">Late</Badge> : isToday(b.delivery_date) ? <Badge tone="gold">Today</Badge> : <Badge>Tomorrow</Badge>}
                      <span className="grow">
                        {b.customer_name} · {b.number}
                      </span>
                      <span className="muted small">{b.status === "ready" ? "Ready" : "Booked"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="Nothing due today or tomorrow" />
              )}
            </section>

            <section className="tint-coral">
              <div className="section-head">
                <h2>Stock to refill</h2>
                <span className="row small">
                  {stats.out_of_stock ? <Badge tone="bad">{stats.out_of_stock} out</Badge> : null}
                  {stats.low_stock ? <Badge tone="warn">{stats.low_stock} low</Badge> : null}
                </span>
              </div>
              {alerts.length ? (
                <>
                  <ul className="list">
                    {alerts.slice(0, 8).map((a) => (
                      <li key={`${a.code}${a.location}`}>
                        <Badge tone={a.status === "out" ? "bad" : "warn"}>{a.status === "out" ? "Out" : "Low"}</Badge>
                        <span className="grow">{a.name}</span>
                        <span className="muted small">{a.location}</span>
                        <span className="num">
                          {a.qty} {a.unit}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {alerts.length > 8 ? (
                    <p className="caption">
                      And {alerts.length - 8} more. <Link to="/stock">Open stock</Link>
                    </p>
                  ) : null}
                </>
              ) : (
                <Empty title="Stock looks fine" />
              )}
              {word !== "today" ? <p className="caption">Stock is as of now, whatever dates are chosen.</p> : null}
            </section>

            {isOwner ? (
              <section>
                <div className="section-head">
                  <h2>Backup</h2>
                </div>
                {backup?.last_local_at ? (
                  <p className="small">
                    Last backup {isToday(backup.last_local_at) ? `today at ${fmtTime(backup.last_local_at)}` : fmtDateTime(backup.last_local_at)}
                    {backup.last_kind === "day" ? " (Day)" : " (Hourly)"}
                    {backup.drive_configured
                      ? backup.drive_error
                        ? "; Google Drive copy failed."
                        : backup.last_drive_at
                          ? `; Google Drive copy at ${fmtTime(backup.last_drive_at)}.`
                          : "."
                      : "; Google Drive folder not set."}
                    {backup.last_day_at ? ` Last Day backup: ${fmtDateTime(backup.last_day_at)}.` : ""}
                  </p>
                ) : null}
                {!backupToday ? <Notice tone="warn">No backup today yet.</Notice> : null}
                {backup?.drive_error ? <Notice tone="bad">Google Drive: {backup.drive_error}</Notice> : null}
                <div>
                  <Button onClick={() => backupNow.mutate()} loading={backupNow.isPending}>
                    <HardDrive size={16} aria-hidden /> Back up now
                  </Button>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

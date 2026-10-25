import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api, errorText, query } from "../lib/api";
import { addDays, fmtDate, todayIso } from "../lib/format";
import { pct, rs } from "../lib/money";
import { useCategories, useSession } from "../lib/session";
import { PAYMENT_MODES, type Report, type ReportColumn } from "../lib/types";
import { Button, Empty, Field, Loading, Notice, PageHead, Tabs } from "../components/ui";

type Kind = "sales-summary" | "products" | "categories" | "profit" | "daily";

function cell(column: ReportColumn, value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "";
  if (column.type === "money") return rs(Number(value));
  if (column.type === "percent") return pct(Number(value));
  if (column.key === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return fmtDate(value);
  return String(value);
}

export default function ReportsPage() {
  const { isOwner, boot } = useSession();
  const categories = useCategories();
  const [kind, setKind] = useState<Kind>("sales-summary");
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [category, setCategory] = useState("");
  const [counter, setCounter] = useState("");
  const [user, setUser] = useState("");
  const [mode, setMode] = useState("");

  const usesCategory = kind === "products" || kind === "categories" || kind === "profit";
  const params = {
    from,
    to,
    category: usesCategory ? category : "",
    counter: kind === "daily" ? "" : counter,
    user: kind === "daily" ? "" : user,
    mode,
  };
  const report = useQuery({
    queryKey: ["report", kind, params],
    queryFn: () => api.get<Report>(`/api/reports/${kind}${query(params)}`),
    placeholderData: keepPreviousData,
  });

  const tabs: { value: Kind; label: string }[] = [
    { value: "sales-summary", label: "Sales summary" },
    { value: "products", label: "Product-wise" },
    { value: "categories", label: "Category-wise" },
    ...(isOwner ? [{ value: "profit" as Kind, label: "Profit" }] : []),
    { value: "daily", label: "Daily summary" },
  ];

  function range(days: number) {
    const today = todayIso();
    setTo(today);
    setFrom(addDays(today, -(days - 1)));
  }

  const data = report.data;
  return (
    <div className="page">
      <PageHead
        title="Reports"
        subtitle="Cancelled bills are never counted. Download any report as an Excel file."
        actions={
          <a className="btn" href={`/api/reports/${kind}${query({ ...params, download: "xlsx" })}`}>
            <Download size={16} aria-hidden /> Download Excel
          </a>
        }
      />
      <Tabs tabs={tabs} value={kind} onChange={setKind} />
      <div className="toolbar">
        <Field label="From">
          <input className="input" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input className="input" type="date" value={to} min={from} max={todayIso()} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </Field>
        <div className="row" style={{ gap: "var(--space-2)", alignSelf: "flex-end" }}>
          <Button size="sm" onClick={() => range(1)}>
            Today
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const y = addDays(todayIso(), -1);
              setFrom(y);
              setTo(y);
            }}
          >
            Yesterday
          </Button>
          <Button size="sm" onClick={() => range(7)}>
            7 days
          </Button>
          <Button size="sm" onClick={() => range(30)}>
            30 days
          </Button>
        </div>
        {usesCategory ? (
          <Field label="Category">
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {kind !== "daily" ? (
          <>
            <Field label="Counter">
              <select className="select" value={counter} onChange={(e) => setCounter(e.target.value)}>
                <option value="">All</option>
                {boot.counters.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Staff">
              <select className="select" value={user} onChange={(e) => setUser(e.target.value)}>
                <option value="">All</option>
                {boot.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}
        <Field label="Paid by">
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">Any</option>
            {PAYMENT_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {report.isPending ? <Loading /> : null}
      {report.isError ? <Notice tone="bad">{errorText(report.error)}</Notice> : null}
      {data ? (
        <div className="stack">
          <p className="muted small">
            {data.title}: {data.period}
          </p>
          {data.notes.map((note) => (
            <Notice key={note} tone={kind === "profit" ? "warn" : "neutral"}>
              {note}
            </Notice>
          ))}
          {data.rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {data.columns.map((c) => (
                      <th key={c.key} className={c.type === "text" ? "" : "num"}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, index) => (
                    <tr key={index}>
                      {data.columns.map((c) => (
                        <td key={c.key} className={c.type === "text" ? "" : "num"}>
                          {cell(c, row[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    {data.columns.map((c) => (
                      <td key={c.key} className={c.type === "text" ? "" : "num"}>
                        {cell(c, data.totals[c.key])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <Empty title="Nothing to show for these dates" />
          )}
        </div>
      ) : null}
    </div>
  );
}

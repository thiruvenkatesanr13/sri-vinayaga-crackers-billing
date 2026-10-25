import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Search, Trash2 } from "lucide-react";
import { api, ApiError, errorText, query } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useCategories, useLocations, useProducts, useSession, useSettings } from "../lib/session";
import type { Location, Paged, Product } from "../lib/types";
import { Badge, Button, Empty, Field, IconButton, Loading, Notice, PageHead, Segmented, Tabs, useToast } from "../components/ui";
import "../styles/inventory.css";

type Tab = "stock" | "move" | "check" | "history";
type Status = "out" | "low" | "ok" | "packed" | "stopped";

interface Transfer {
  id: number;
  from_location: string;
  to_location: string;
  note: string;
  user: string;
  at: string;
  lines: { product_id: number; code: string; name: string; quantity: number }[];
}

interface Adjustment {
  id: number;
  kind: "count" | "damage";
  product: string;
  location: string;
  expected: number;
  counted: number;
  difference: number;
  note: string;
  user: string;
  at: string;
}

interface Movement {
  id: number;
  at: string;
  product_id: number;
  product_code: string;
  product_name: string;
  unit: string;
  location: string;
  change: number;
  balance_after: number;
  reason: string;
  reason_label: string;
  note: string;
  user: string;
}

type Shortage = { product_id: number; name: string; unit: string; needed: number; available: number };
type MoveLine = { key: number; productId: number; qty: string; byCase: boolean };

const TABS: { value: Tab; label: string; owner?: boolean }[] = [
  { value: "stock", label: "Stock" },
  { value: "move", label: "Move stock" },
  { value: "check", label: "Stock check", owner: true },
  { value: "history", label: "History" },
];

const REASONS: [string, string][] = [
  ["sale", "Sale"],
  ["sale_cancel", "Bill cancelled"],
  ["purchase", "Purchase"],
  ["opening", "Opening stock"],
  ["sheet_add", "Added in stock sheet"],
  ["sheet_remove", "Removed in stock sheet"],
  ["transfer_in", "Moved in"],
  ["transfer_out", "Moved out"],
  ["count", "Stock check"],
  ["damage", "Damaged"],
];
const REASON_LABEL: Record<string, string> = Object.fromEntries(REASONS);

const STATUS: Record<Status, ["neutral" | "good" | "warn" | "bad", string]> = {
  out: ["bad", "Out"],
  low: ["warn", "Low"],
  ok: ["good", "OK"],
  packed: ["neutral", "Packed at sale"],
  stopped: ["neutral", "Stopped"],
};

const PAGE_SIZE = 50;
const RECENT = 15;

const digits = (text: string, max: number) => text.replace(/\D/g, "").slice(0, max);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const qtyAt = (product: Product, locationId: number) => product.stock[String(locationId)] ?? 0;
const packedAtSale = (product: Product) => product.is_gift_box && product.gift_box_mode === "components";
const matches = (product: Product, words: string[]) => words.every((w) => `${product.name} ${product.code}`.toLowerCase().includes(w));
const invalidate = (client: ReturnType<typeof useQueryClient>, keys: string[]) => keys.forEach((key) => void client.invalidateQueries({ queryKey: [key] }));

/** Status at the billing shop, where bills take stock from. */
function statusOf(product: Product, lowDefault: number | null): Status {
  if (packedAtSale(product)) return "packed";
  if (!product.is_active) return "stopped";
  if (product.sale_stock <= 0) return "out";
  const level = product.low_stock_level ?? lowDefault;
  return level !== null && product.sale_stock <= level ? "low" : "ok";
}

/** Active places, plus a closed place while some product still has stock there. */
function stockPlaces(locations: Location[], products: Product[]): Location[] {
  return locations.filter((l) => l.is_active || products.some((p) => qtyAt(p, l.id) !== 0));
}

function Delta({ value, unit }: { value: number; unit?: string }) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return (
    <span className={`inv-delta ${value > 0 ? "up" : value < 0 ? "down" : ""}`}>
      {sign}
      {Math.abs(value)}
      {unit ? ` ${unit}` : ""}
    </span>
  );
}

type FinderProps = { products: Product[]; onPick: (p: Product) => void; label: string; meta?: (p: Product) => ReactNode; inputRef?: RefObject<HTMLInputElement | null> };

/** Type a name or code, then tap a match (or press Enter for the first one). */
function Finder({ products, onPick, label, meta, inputRef }: FinderProps) {
  const [text, setText] = useState("");
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  const listRef = useRef<HTMLUListElement>(null);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const results = words.length ? products.filter((p) => matches(p, words)).slice(0, 6) : [];

  function pick(product: Product) {
    onPick(product);
    setText("");
    ref.current?.focus();
  }

  function onInputKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && results[0]) pick(results[0]);
    else if (event.key === "ArrowDown" && results.length) listRef.current?.querySelector("button")?.focus();
    else return;
    event.preventDefault();
  }

  function onListKey(event: KeyboardEvent<HTMLUListElement>) {
    const buttons = Array.from(listRef.current?.querySelectorAll("button") ?? []);
    const index = buttons.findIndex((b) => b === document.activeElement);
    if (event.key === "ArrowDown") buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
    else if (event.key === "ArrowUp") (index > 0 ? buttons[index - 1] : ref.current)?.focus();
    else return;
    event.preventDefault();
  }

  return (
    <div>
      <div className="search">
        <Search size={18} aria-hidden />
        <input ref={ref} className="input" value={text} placeholder={label} aria-label={label} onChange={(e) => setText(e.target.value)} onKeyDown={onInputKey} />
      </div>
      {results.length ? (
        <ul className="inv-picks" ref={listRef} aria-label="Matching items" onKeyDown={onListKey}>
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" className="inv-pick" onClick={() => pick(p)}>
                <span className="code">{p.code}</span>
                <span className="grow">{p.name}</span>
                {meta ? <span className="meta">{meta(p)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : words.length ? (
        <p className="inv-none">No item matches “{text.trim()}”.</p>
      ) : null}
    </div>
  );
}

export default function StockPage() {
  const { isOwner } = useSession();
  const [params, setParams] = useSearchParams();
  const products = useProducts().data;
  const locations = useLocations().data ?? [];
  const lowDefault = useSettings().data?.low_stock_default ?? null;
  const [historyProduct, setHistoryProduct] = useState("");
  const tabs = TABS.filter((t) => isOwner || !t.owner);
  const tab = tabs.find((t) => t.value === params.get("tab"))?.value ?? "stock";
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([tab]));

  // Tabs stay mounted once opened, so a half-filled move or check survives a look at another tab.
  useEffect(() => setVisited((seen) => (seen.has(tab) ? seen : new Set(seen).add(tab))), [tab]);

  function go(next: Tab) {
    setParams(next === "stock" ? {} : { tab: next }, { replace: true });
  }

  function showHistory(productId: number) {
    setHistoryProduct(String(productId));
    go("history");
  }

  const shop = locations.find((l) => l.is_sale_location);
  const statuses = (products ?? []).map((p) => statusOf(p, lowDefault));
  const out = statuses.filter((s) => s === "out").length;
  const low = statuses.filter((s) => s === "low").length;
  const panel = (value: Tab, content: ReactNode) =>
    tab === value || visited.has(value) ? <div hidden={tab !== value}>{content}</div> : null;

  return (
    <div className="page inv">
      <PageHead title="Stock" subtitle={products && shop ? `${shop.name}: ${out} out, ${low} low` : undefined} />
      <Tabs tabs={tabs} value={tab} onChange={go} />
      {panel("stock", <StockTab onHistory={showHistory} />)}
      {panel("move", <MoveTab />)}
      {isOwner ? panel("check", <CheckTab />) : null}
      {panel("history", <HistoryTab product={historyProduct} onProduct={setHistoryProduct} />)}
    </div>
  );
}

function StockTab({ onHistory }: { onHistory: (productId: number) => void }) {
  const productsQuery = useProducts();
  const categories = useCategories().data ?? [];
  const locations = useLocations().data ?? [];
  const lowDefault = useSettings().data?.low_stock_default ?? null;
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);

  if (productsQuery.isPending) return <Loading label="Loading stock" />;
  if (productsQuery.isError) return <Notice tone="bad">{errorText(productsQuery.error)}</Notice>;

  const products = productsQuery.data;
  const places = stockPlaces(locations, products);
  const shop = places.find((l) => l.is_sale_location);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = products.filter((p) => {
    const status = statusOf(p, lowDefault);
    if (!p.is_active && !places.some((l) => qtyAt(p, l.id) !== 0)) return false;
    if (onlyLow && status !== "out" && status !== "low") return false;
    return (!category || String(p.category_id) === category) && matches(p, words);
  });

  return (
    <>
      <div className="toolbar">
        <Field label="Search">
          <div className="search">
            <Search size={18} aria-hidden />
            <input className="input" value={search} placeholder="Name or code" onChange={(e) => setSearch(e.target.value)} />
          </div>
        </Field>
        <Field label="Category">
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
          Only low or out
        </label>
      </div>
      {rows.length ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Item</th>
                  {places.map((l) => <th key={l.id} className="num">{l.is_active ? l.name : `${l.name} (closed)`}</th>)}
                  {places.length > 1 ? <th className="num">Total</th> : null}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const status = statusOf(p, lowDefault);
                  const packed = status === "packed";
                  return (
                    <tr key={p.id} className="clickable" tabIndex={0} title="See this item’s history" onClick={() => onHistory(p.id)} onKeyDown={(e) => e.key === "Enter" && onHistory(p.id)}>
                      <td className="muted inv-code">{p.code}</td>
                      <td>
                        {p.name} <span className="muted small">{p.unit_name}</span>
                      </td>
                      {places.map((l) => <td key={l.id} className="num">{packed ? "—" : qtyAt(p, l.id)}</td>)}
                      {places.length > 1 ? <td className="num">{packed ? "—" : places.reduce((n, l) => n + qtyAt(p, l.id), 0)}</td> : null}
                      <td>
                        <Badge tone={STATUS[status][0]}>{STATUS[status][1]}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="caption">
            Status is for {shop?.name ?? "the billing shop"}. Low means at or below the item’s low-stock level
            {lowDefault === null ? "" : ` (shop default ${lowDefault})`}. Tap an item to see its history.
          </p>
        </>
      ) : (
        <Empty title={products.length ? "No item matches" : "No products yet"}>
          {products.length ? (onlyLow ? "Nothing is low or out here." : "Check the spelling, or choose another category.") : "Products appear here once they are added."}
        </Empty>
      )}
    </>
  );
}

function MoveTab() {
  const client = useQueryClient();
  const notify = useToast();
  const products = useProducts().data ?? [];
  const locationsQuery = useLocations();
  const locations = locationsQuery.data ?? [];
  const active = locations.filter((l) => l.is_active);
  const shop = active.find((l) => l.is_sale_location) ?? active[0];
  const godown = active.find((l) => l.id !== shop?.id && l.kind === "godown") ?? active.find((l) => l.id !== shop?.id);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<MoveLine[]>([]);
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<ReactNode>(null);
  const finderRef = useRef<HTMLInputElement>(null);
  const focusKey = useRef<number | null>(null);
  const nextKey = useRef(1);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const source = active.find((l) => String(l.id) === fromId) ?? godown ?? shop;
  const target = active.find((l) => String(l.id) === toId) ?? (source?.id === shop?.id ? godown : shop);
  const rows = lines.map((line) => {
    const product = byId.get(line.productId);
    const factor = line.byCase && product?.units_per_case ? product.units_per_case : 1;
    const base = (Number(line.qty) || 0) * factor;
    const available = product && source ? qtyAt(product, source.id) : null;
    const error = !product
      ? "This item is no longer listed."
      : !base
        ? "Enter how many."
        : available !== null && base > available
          ? `Only ${available} ${product.unit_name} in ${source?.name}.`
          : null;
    return { ...line, product, base, available, error };
  });
  const formError = !rows.length
    ? "Add at least one item."
    : !source || !target
      ? "Choose the places."
      : source.id === target.id
        ? "Choose two different places."
        : rows.some((r) => r.error)
          ? "Check the items marked in red."
          : null;
  const pickable = products.filter(
    (p) => !packedAtSale(p) && !lines.some((l) => l.productId === p.id) && (p.is_active || (!!source && qtyAt(p, source.id) > 0)),
  );

  function update(key: number, patch: Partial<MoveLine>) {
    setLines((list) => list.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function add(product: Product) {
    const key = nextKey.current++;
    focusKey.current = key;
    setLines((list) => [...list, { key, productId: product.id, qty: "", byCase: false }]);
    setProblem(null);
  }

  const save = useMutation({
    mutationFn: () =>
      api.post<Transfer>("/api/stock/transfers", {
        from_location_id: source?.id ?? null,
        to_location_id: target?.id ?? null,
        note: note.trim(),
        lines: rows.map((r) => ({ product_id: r.productId, quantity: r.base })),
      }),
    onSuccess: (transfer) => {
      invalidate(client, ["products", "dashboard", "stock-movements", "transfers"]);
      setLines([]);
      setNote("");
      setTried(false);
      setProblem(null);
      notify(`Moved ${plural(transfer.lines.length, "item")} from ${transfer.from_location} to ${transfer.to_location}.`);
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.code === "insufficient_stock")) return setProblem(errorText(error));
      const short = (error.data.items as Shortage[] | undefined) ?? [];
      void client.invalidateQueries({ queryKey: ["products"] });
      setProblem(
        <>
          Not enough stock in {source?.name}. Nothing was moved.
          <ul style={{ margin: "var(--space-1) 0 0", paddingLeft: "1.2em" }}>
            {short.map((i) => (
              <li key={i.product_id}>
                {i.name}: moving {i.needed}, only {i.available} {i.unit} there
              </li>
            ))}
          </ul>
        </>,
      );
    },
  });

  function submit() {
    setTried(true);
    setProblem(null);
    if (!formError) save.mutate();
  }

  const placeSelect = (label: string, value: Location | undefined, onChange: (id: string) => void) => (
    <Field label={label}>
      <select className="select" value={value?.id ?? ""} onChange={(e) => onChange(e.target.value)}>
        {value ? null : <option value="">Choose a place</option>}
        {active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </Field>
  );

  if (locationsQuery.isPending) return <Loading label="Loading places" />;

  if (active.length < 2) {
    return (
      <div className="stack">
        <Notice>
          Moving stock needs two places, such as the godown and the shop. The owner can add a place in Settings → Counters &amp; places.
        </Notice>
        <RecentMoves />
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="small muted">Move stock between the godown and the shop.</p>
      <div className="inv-places">
        {placeSelect("From", source, setFromId)}
        <IconButton
          label="Swap from and to"
          onClick={() => {
            setFromId(String(target?.id ?? ""));
            setToId(String(source?.id ?? ""));
          }}
        >
          <ArrowRightLeft size={18} />
        </IconButton>
        {placeSelect("To", target, setToId)}
      </div>

      <Finder
        products={pickable}
        inputRef={finderRef}
        label="Add an item: type its name or code"
        meta={(p) => (source ? `${qtyAt(p, source.id)} ${p.unit_name} in ${source.name}` : p.unit_name)}
        onPick={add}
      />
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                {source ? <th className="num">In {source.name}</th> : null}
                <th className="num">How many</th>
                <th><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const unit = row.product?.unit_name ?? "";
                const showError = row.error && (tried || row.qty !== "" || !row.product);
                return (
                  <tr key={row.key}>
                    <td>
                      {row.product?.name ?? "Unknown item"}
                      <span className="inv-sub">{row.product?.code}</span>
                      {showError ? <span className="inv-error">{row.error}</span> : null}
                    </td>
                    {source ? <td className="num">{row.available} {unit}</td> : null}
                    <td>
                      <div className="inv-qty">
                        <input
                          className="input"
                          inputMode="numeric"
                          value={row.qty}
                          aria-label={`How many ${row.product?.name ?? ""}`}
                          aria-invalid={showError ? true : undefined}
                          ref={(el) => {
                            if (el && focusKey.current === row.key) {
                              el.focus();
                              focusKey.current = null;
                            }
                          }}
                          onChange={(e) => update(row.key, { qty: digits(e.target.value, 6) })}
                          onKeyDown={(e) => e.key === "Enter" && finderRef.current?.focus()}
                        />
                        {row.product?.units_per_case ? (
                          <div className="unit-toggle" role="group" aria-label="Count in">
                            <button type="button" aria-pressed={!row.byCase} onClick={() => update(row.key, { byCase: false })}>{unit}</button>
                            <button type="button" aria-pressed={row.byCase} onClick={() => update(row.key, { byCase: true })}>Bundle</button>
                          </div>
                        ) : (
                          <span className="small muted">{unit}</span>
                        )}
                      </div>
                      {row.byCase && row.base ? <span className="inv-sub" style={{ textAlign: "right" }}>= {row.base} {unit}</span> : null}
                    </td>
                    <td>
                      <IconButton label={`Remove ${row.product?.name ?? "item"}`} onClick={() => setLines((list) => list.filter((l) => l.key !== row.key))}>
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
        <p className="small muted">No items yet. Type an item name above and press Enter, or tap it.</p>
      )}

      <Field label="Note" hint="Optional">
        <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {problem ? <Notice tone="bad">{problem}</Notice> : tried && formError ? <Notice tone="bad">{formError}</Notice> : null}
      <div className="row">
        <Button variant="primary" size="lg" loading={save.isPending} onClick={submit}>
          Move stock
        </Button>
        {rows.length ? <span className="small muted">{plural(rows.length, "item")}</span> : null}
      </div>
      <RecentMoves />
    </div>
  );
}

function RecentMoves() {
  const transfers = useQuery({ queryKey: ["transfers"], queryFn: () => api.get<Transfer[]>("/api/stock/transfers") });
  const [all, setAll] = useState(false);
  const list = transfers.data ?? [];
  return (
    <section className="section">
      <div className="section-head">
        <h2>Recent moves</h2>
      </div>
      {transfers.isPending ? <Loading /> : null}
      {transfers.isError ? <Notice tone="bad">{errorText(transfers.error)}</Notice> : null}
      {transfers.isSuccess && !list.length ? <Empty title="No moves yet">Moves between the godown and the shop show up here.</Empty> : null}
      {list.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>From → to</th>
                <th>Items</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {(all ? list : list.slice(0, RECENT)).map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(t.at)}</td>
                  <td>
                    {t.from_location} → {t.to_location}
                  </td>
                  <td>
                    <details>
                      <summary>{plural(t.lines.length, "item")}</summary>
                      <ul>
                        {t.lines.map((l) => <li key={l.product_id}>{l.quantity} × {l.name}</li>)}
                      </ul>
                    </details>
                    {t.note ? <span className="inv-sub">{t.note}</span> : null}
                  </td>
                  <td>{t.user}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.length > RECENT && !all ? (
        <div className="row" style={{ marginTop: "var(--space-3)" }}>
          <Button size="sm" onClick={() => setAll(true)}>Show all {list.length}</Button>
        </div>
      ) : null}
    </section>
  );
}

function CheckTab() {
  const client = useQueryClient();
  const notify = useToast();
  const productsQuery = useProducts();
  const products = productsQuery.data ?? [];
  const locationsQuery = useLocations();
  const active = (locationsQuery.data ?? []).filter((l) => l.is_active);
  const [productId, setProductId] = useState<number | null>(null);
  const [placeId, setPlaceId] = useState("");
  const [mode, setMode] = useState<"count" | "damage">("count");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const product = products.find((p) => p.id === productId);
  const place = active.find((l) => String(l.id) === placeId) ?? active.find((l) => l.is_sale_location) ?? active[0];
  const unit = product?.unit_name ?? "";
  const expected = product && place ? qtyAt(product, place.id) : 0;
  const n = amount === "" ? null : Number(amount);
  const change = n === null ? null : mode === "count" ? n - expected : -n;
  const error =
    mode === "damage" && n !== null ? (n <= 0 ? "Enter how many are damaged." : n > expected ? `Only ${expected} ${unit} in ${place?.name}.` : null) : null;

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number; difference: number }>("/api/stock/adjustments", {
        kind: mode,
        product_id: product?.id,
        location_id: place?.id,
        counted: mode === "count" ? n : undefined,
        quantity: mode === "damage" ? n : undefined,
        note: note.trim(),
      }),
    onSuccess: (saved) => {
      invalidate(client, ["products", "dashboard", "stock-movements", "adjustments"]);
      const diff = saved.difference;
      notify(diff === 0 ? `Saved. ${product?.name} matches.` : `Saved. ${product?.name} stock ${diff > 0 ? "up" : "down"} by ${Math.abs(diff)} ${unit}.`);
      setProductId(null);
      setAmount("");
      setNote("");
    },
    onError: (failure) => notify(errorText(failure), "bad"),
  });

  if (locationsQuery.isPending || productsQuery.isPending) return <Loading label="Loading items" />;

  return (
    <div className="stack">
      <p className="small muted">Count an item, or record damaged stock. The stock is corrected to what you enter, and the change is kept in History.</p>
      <div className="panel stack" style={{ maxWidth: 640 }}>
        {product && place ? (
          <>
            <div className="spread">
              <strong>
                {product.code} · {product.name}
              </strong>
              <Button size="sm" variant="ghost" onClick={() => setProductId(null)}>Change item</Button>
            </div>
            <div className="form-grid">
              <Field label="Place">
                <select className="select" value={place.id} onChange={(e) => setPlaceId(e.target.value)}>
                  {active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
              <div className="field">
                <span>System count now</span>
                <strong className="num" style={{ textAlign: "left", fontSize: "var(--text-lg)" }}>{expected} {unit}</strong>
              </div>
            </div>
            <Segmented
              label="What are you recording?"
              value={mode}
              onChange={setMode}
              options={[{ value: "count", label: "Counted" }, { value: "damage", label: "Damaged" }]}
            />
            <Field label={mode === "count" ? `How many ${unit} did you count?` : `How many ${unit} are damaged?`} error={error}>
              <input className="input inv-num-input" inputMode="numeric" value={amount} autoFocus onChange={(e) => setAmount(digits(e.target.value, 6))} />
            </Field>
            {change !== null && !error ? (
              <p className="small">
                {mode === "count" && change === 0 ? "Matches the system count. Saving records the check." : <>Stock changes by <Delta value={change} unit={unit} />, to {expected + change} {unit}.</>}
              </p>
            ) : null}
            <Field label="Note" hint={mode === "damage" ? "What happened, for example wet in rain" : "Optional"}>
              <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="row">
              <Button variant="primary" loading={save.isPending} disabled={n === null || !!error} onClick={() => save.mutate()}>
                {mode === "count" ? "Save count" : "Record damage"}
              </Button>
            </div>
          </>
        ) : (
          <Finder
            products={products.filter((p) => !packedAtSale(p))}
            label="Find the item you are checking"
            meta={(p) => (place ? `${qtyAt(p, place.id)} ${p.unit_name} in ${place.name}` : p.unit_name)}
            onPick={(p) => {
              setProductId(p.id);
              setAmount("");
              void productsQuery.refetch();
            }}
          />
        )}
      </div>
      <RecentChecks />
    </div>
  );
}

function RecentChecks() {
  const checks = useQuery({ queryKey: ["adjustments"], queryFn: () => api.get<Adjustment[]>("/api/stock/adjustments") });
  const [all, setAll] = useState(false);
  const list = checks.data ?? [];
  return (
    <section className="section">
      <div className="section-head">
        <h2>Recent checks</h2>
      </div>
      {checks.isPending ? <Loading /> : null}
      {checks.isError ? <Notice tone="bad">{errorText(checks.error)}</Notice> : null}
      {checks.isSuccess && !list.length ? <Empty title="No checks yet">Counts and damage you record show up here.</Empty> : null}
      {list.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Item</th>
                <th>Place</th>
                <th>Type</th>
                <th className="num">Expected</th>
                <th className="num">Now</th>
                <th className="num">Difference</th>
                <th>Note</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {(all ? list : list.slice(0, RECENT)).map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(a.at)}</td>
                  <td>{a.product}</td>
                  <td>{a.location}</td>
                  <td>{a.kind === "damage" ? <Badge tone="warn">Damaged</Badge> : <Badge>Counted</Badge>}</td>
                  <td className="num">{a.expected}</td>
                  <td className="num">{a.counted}</td>
                  <td className="num"><Delta value={a.difference} /></td>
                  <td>{a.note}</td>
                  <td>{a.user}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.length > RECENT && !all ? (
        <div className="row" style={{ marginTop: "var(--space-3)" }}>
          <Button size="sm" onClick={() => setAll(true)}>Show all {list.length}</Button>
        </div>
      ) : null}
    </section>
  );
}

function HistoryTab({ product, onProduct }: { product: string; onProduct: (id: string) => void }) {
  const products = useProducts().data ?? [];
  const categories = useCategories().data ?? [];
  const locations = useLocations().data ?? [];
  const [place, setPlace] = useState("");
  const [reason, setReason] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const badRange = !!from && !!to && from > to;
  const filters = { product, location: place, reason, from, to };

  const history = useInfiniteQuery({
    queryKey: ["stock-movements", filters],
    queryFn: ({ pageParam }) => api.get<Paged<Movement>>(`/api/stock/movements${query({ ...filters, limit: PAGE_SIZE, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.results.length, 0);
      return loaded < last.count && last.results.length ? loaded : undefined;
    },
    enabled: !badRange,
  });

  // New stock changes can shift pages while loading more, so skip any row already shown.
  const seen = new Set<number>();
  const rows = (history.data?.pages ?? []).flatMap((page) => page.results).filter((m) => !seen.has(m.id) && !!seen.add(m.id));
  const total = history.data?.pages.at(-1)?.count ?? 0;
  const filtered = !!(product || place || reason || from || to);

  function clear() {
    onProduct("");
    setPlace("");
    setReason("");
    setFrom("");
    setTo("");
  }

  return (
    <>
      <div className="toolbar">
        <Field label="Item">
          <select className="select" value={product} onChange={(e) => onProduct(e.target.value)}>
            <option value="">All items</option>
            {categories.map((c) => {
              const list = products.filter((p) => p.category_id === c.id);
              return list.length ? (
                <optgroup key={c.id} label={c.name}>
                  {list.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                </optgroup>
              ) : null;
            })}
          </select>
        </Field>
        <Field label="Place">
          <select className="select" value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">All places</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
        <Field label="Reason">
          <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">All reasons</option>
            {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="From">
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {filtered ? <Button variant="ghost" onClick={clear}>Clear filters</Button> : null}
      </div>

      {badRange ? <Notice tone="warn">The From date is after the To date. Change one of them.</Notice> : null}
      {history.isError ? <Notice tone="bad">{errorText(history.error)}</Notice> : null}
      {history.isPending && !badRange ? <Loading label="Loading history" /> : null}
      {history.isSuccess && !rows.length ? (
        <Empty title="No stock changes found">{filtered ? "Try other filters." : "Sales, moves, purchases and checks show up here."}</Empty>
      ) : null}
      {rows.length ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Item</th>
                  <th>Place</th>
                  <th className="num">Change</th>
                  <th className="num">Stock after</th>
                  <th>Reason</th>
                  <th>Note</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(m.at)}</td>
                    <td>
                      {m.product_name}
                      <span className="inv-sub">{m.product_code}</span>
                    </td>
                    <td>{m.location}</td>
                    <td className="num"><Delta value={m.change} unit={m.unit} /></td>
                    <td className="num">{m.balance_after}</td>
                    <td>{REASON_LABEL[m.reason] ?? m.reason_label}</td>
                    <td>{m.note}</td>
                    <td>{m.user}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="spread" style={{ marginTop: "var(--space-3)" }}>
            <span className="small muted">Showing {rows.length} of {total}</span>
            {history.hasNextPage ? (
              <Button onClick={() => void history.fetchNextPage()} loading={history.isFetchingNextPage}>Load more</Button>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

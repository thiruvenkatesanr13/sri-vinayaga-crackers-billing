import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2, UserPlus } from "lucide-react";
import { api, errorText } from "../lib/api";
import { fmtDate, fmtDateTime, todayIso } from "../lib/format";
import { rs } from "../lib/money";
import { useLocations, useProducts, useSession } from "../lib/session";
import type { Product } from "../lib/types";
import { Button, Dialog, Empty, Field, IconButton, Loading, MoneyInput, Notice, PageHead, Tabs, useToast } from "../components/ui";
import "../styles/inventory.css";

interface Supplier {
  id: number;
  name: string;
  phone: string;
  gstin: string;
}

interface Purchase {
  id: number;
  supplier: string;
  bill_number: string;
  bill_date: string;
  location: string;
  goods_paise: number;
  transport_paise: number;
  total_paise: number;
  note: string;
  user: string;
  at: string;
  lines: { product_id: number; code: string; name: string; quantity: number; unit_cost_paise: number; landed_unit_cost_paise: number }[];
}

type Line = { key: number; productId: number; qty: string; byCase: boolean; cost: number | null };

const LIST_LIMIT = 100;

const digits = (text: string, max: number) => text.replace(/\D/g, "").slice(0, max);
const matches = (product: Product, words: string[]) => words.every((w) => `${product.name} ${product.code}`.toLowerCase().includes(w));
const invalidate = (client: ReturnType<typeof useQueryClient>, keys: string[]) => keys.forEach((key) => void client.invalidateQueries({ queryKey: [key] }));
const byName = (a: Supplier, b: Supplier) => a.name.localeCompare(b.name);

/** Type a name or code, then tap a match (or press Enter for the first one). */
function Finder({ products, onPick, label, meta }: { products: Product[]; onPick: (p: Product) => void; label: string; meta?: (p: Product) => ReactNode }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const results = words.length ? products.filter((p) => matches(p, words)).slice(0, 6) : [];

  function pick(product: Product) {
    onPick(product);
    setText("");
    inputRef.current?.focus();
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
    else if (event.key === "ArrowUp") (index > 0 ? buttons[index - 1] : inputRef.current)?.focus();
    else return;
    event.preventDefault();
  }

  return (
    <div>
      <div className="search">
        <Search size={18} aria-hidden />
        <input ref={inputRef} className="input" value={text} placeholder={label} aria-label={label} onChange={(e) => setText(e.target.value)} onKeyDown={onInputKey} />
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

export default function PurchasesPage() {
  const { isOwner } = useSession();
  const [tab, setTab] = useState<"purchases" | "suppliers">("purchases");
  const [creating, setCreating] = useState(false);
  const [draftRun, setDraftRun] = useState(0);
  const [viewing, setViewing] = useState<Purchase | null>(null);
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const purchases = useQuery({ queryKey: ["purchases"], queryFn: () => api.get<Purchase[]>("/api/purchases"), enabled: isOwner });
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => api.get<Supplier[]>("/api/suppliers"), enabled: isOwner });

  if (!isOwner) {
    return (
      <div className="page inv">
        <Notice tone="warn">Only the owner can see purchases.</Notice>
      </div>
    );
  }

  const list = purchases.data ?? [];
  const supplierList = suppliers.data ?? [];
  const sum = (pick: (p: Purchase) => number) => list.reduce((total, p) => total + pick(p), 0);
  const newPurchase = (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <Plus size={16} aria-hidden />
      New purchase
    </Button>
  );
  const addSupplier = (
    <Button variant="primary" onClick={() => setEditing("new")}>
      <UserPlus size={16} aria-hidden />
      Add supplier
    </Button>
  );

  return (
    <div className="page inv">
      <PageHead title="Purchases" subtitle="Supplier bills. Saving one adds the stock and updates item costs." actions={tab === "purchases" ? newPurchase : addSupplier} />
      <Tabs
        tabs={[
          { value: "purchases", label: "Purchases" },
          { value: "suppliers", label: "Suppliers" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "purchases" ? (
        purchases.isPending ? (
          <Loading label="Loading purchases" />
        ) : purchases.isError ? (
          <Notice tone="bad">{errorText(purchases.error)}</Notice>
        ) : list.length ? (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Bill date</th>
                    <th>Supplier</th>
                    <th>Bill no.</th>
                    <th>Stock went to</th>
                    <th className="num">Goods</th>
                    <th className="num">Transport</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id} className="clickable" tabIndex={0} onClick={() => setViewing(p)} onKeyDown={(e) => e.key === "Enter" && setViewing(p)}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDate(p.bill_date)}</td>
                      <td>{p.supplier || <span className="muted">No supplier</span>}</td>
                      <td>{p.bill_number || "—"}</td>
                      <td>{p.location}</td>
                      <td className="num">{rs(p.goods_paise)}</td>
                      <td className="num">{rs(p.transport_paise)}</td>
                      <td className="num">{rs(p.total_paise)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{list.length === 1 ? "1 bill" : `${list.length} bills`}</td>
                    <td className="num">{rs(sum((p) => p.goods_paise))}</td>
                    <td className="num">{rs(sum((p) => p.transport_paise))}</td>
                    <td className="num">{rs(sum((p) => p.total_paise))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="caption">
              {list.length >= LIST_LIMIT ? `Showing the latest ${LIST_LIMIT} bills. ` : ""}Tap a bill to see its items and the cost with transport.
            </p>
          </>
        ) : (
          <Empty title="No purchases yet">
            Enter a supplier bill here. The stock goes in, and item costs include the transport.
            <div className="row" style={{ justifyContent: "center", marginTop: "var(--space-4)" }}>{newPurchase}</div>
          </Empty>
        )
      ) : suppliers.isPending ? (
        <Loading label="Loading suppliers" />
      ) : suppliers.isError ? (
        <Notice tone="bad">{errorText(suppliers.error)}</Notice>
      ) : supplierList.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>GSTIN</th>
              </tr>
            </thead>
            <tbody>
              {supplierList.map((s) => (
                <tr key={s.id} className="clickable" tabIndex={0} title="Change this supplier" onClick={() => setEditing(s)} onKeyDown={(e) => e.key === "Enter" && setEditing(s)}>
                  <td>{s.name}</td>
                  <td>{s.phone || <span className="muted">—</span>}</td>
                  <td>{s.gstin || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No suppliers yet">
          Add the companies you buy stock from. You can also add one while entering a purchase.
          <div className="row" style={{ justifyContent: "center", marginTop: "var(--space-4)" }}>{addSupplier}</div>
        </Empty>
      )}

      <NewPurchase
        key={draftRun}
        open={creating}
        suppliers={supplierList}
        onClose={() => setCreating(false)}
        onClear={() => setDraftRun((n) => n + 1)}
        onSaved={() => {
          setCreating(false);
          setDraftRun((n) => n + 1);
        }}
      />
      {viewing ? <PurchaseDetails purchase={viewing} onClose={() => setViewing(null)} /> : null}
      {editing ? <SupplierDialog supplier={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

type NewPurchaseProps = { open: boolean; suppliers: Supplier[]; onClose: () => void; onClear: () => void; onSaved: () => void };

/** Stays mounted while closed, so a half-entered bill is still there when reopened. */
function NewPurchase({ open, suppliers, onClose, onClear, onSaved }: NewPurchaseProps) {
  const client = useQueryClient();
  const notify = useToast();
  const products = useProducts().data ?? [];
  const active = (useLocations().data ?? []).filter((l) => l.is_active);
  const fallback = active.find((l) => l.kind === "godown" && !l.is_sale_location) ?? active.find((l) => l.is_sale_location) ?? active[0];
  const [supplierId, setSupplierId] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState(todayIso);
  const [placeId, setPlaceId] = useState("");
  const [transport, setTransport] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState<{ name: string; phone: string } | null>(null);
  const nextKey = useRef(1);
  const focusKey = useRef<number | null>(null);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const place = active.find((l) => String(l.id) === placeId) ?? fallback;
  const rows = lines.map((line) => {
    const product = byId.get(line.productId);
    const factor = line.byCase && product?.units_per_case ? product.units_per_case : 1;
    const base = (Number(line.qty) || 0) * factor;
    const amount = line.cost === null ? 0 : base * line.cost;
    const error = !product
      ? "This item is no longer listed."
      : !base
        ? "Enter how many."
        : line.cost === null
          ? `Enter the cost per ${product.unit_name}.`
          : null;
    return { ...line, product, base, amount, error };
  });
  const goods = rows.reduce((total, r) => total + r.amount, 0);
  const freight = transport ?? 0;
  const formError = !rows.length
    ? "Add at least one item."
    : !billDate
      ? "Enter the bill date."
      : !place
        ? "Choose where the stock goes."
        : rows.some((r) => r.error)
          ? "Check the items marked in red."
          : null;
  const pickable = products.filter((p) => p.is_active && !(p.is_gift_box && p.gift_box_mode === "components") && !lines.some((l) => l.productId === p.id));
  const blank = !lines.length && !supplierId && !billNumber && !note && !transport && !placeId;

  function update(key: number, patch: Partial<Line>) {
    setLines((list) => list.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function add(product: Product) {
    const key = nextKey.current++;
    focusKey.current = key;
    setLines((list) => [...list, { key, productId: product.id, qty: "", byCase: false, cost: null }]);
  }

  const createSupplier = useMutation({
    mutationFn: (fields: { name: string; phone: string }) => api.post<Supplier>("/api/suppliers", { name: fields.name.trim(), phone: fields.phone.trim(), gstin: "" }),
    onSuccess: (created) => {
      client.setQueryData<Supplier[]>(["suppliers"], (current) => current && [...current, created].sort(byName));
      void client.invalidateQueries({ queryKey: ["suppliers"] });
      setSupplierId(String(created.id));
      setNewSupplier(null);
      notify(`Added ${created.name}.`);
    },
    onError: (error) => notify(errorText(error), "bad"),
  });

  const save = useMutation({
    mutationFn: () =>
      api.post<Purchase>("/api/purchases", {
        supplier_id: supplierId ? Number(supplierId) : null,
        bill_number: billNumber.trim(),
        bill_date: billDate,
        location_id: place?.id,
        transport_paise: freight,
        note: note.trim(),
        lines: rows.map((r) => ({ product_id: r.productId, quantity: r.base, unit_cost_paise: r.cost })),
      }),
    onSuccess: (purchase) => {
      invalidate(client, ["purchases", "products", "dashboard", "stock-movements"]);
      notify(`Purchase saved. Stock added to ${purchase.location}.`);
      onSaved();
    },
    onError: (error) => setProblem(errorText(error)),
  });

  function submit() {
    setTried(true);
    setProblem(null);
    if (!formError) save.mutate();
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClear} disabled={blank || save.isPending}>Clear form</Button>
      <Button onClick={onClose}>Close</Button>
      <Button variant="primary" loading={save.isPending} onClick={submit}>Save purchase</Button>
    </>
  );

  return (
    <Dialog open={open} wide title="New purchase" onClose={onClose} footer={footer}>
      <div className="stack">
        <div className="form-grid">
          <div className="stack" style={{ gap: "var(--space-1)" }}>
            <Field label="Supplier">
              <select className="select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">No supplier</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            {newSupplier ? null : (
              <Button size="sm" variant="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setNewSupplier({ name: "", phone: "" })}>
                <UserPlus size={14} aria-hidden />
                New supplier
              </Button>
            )}
          </div>
          <Field label="Bill number" hint="As printed on the supplier’s bill">
            <input className="input" value={billNumber} maxLength={40} onChange={(e) => setBillNumber(e.target.value)} />
          </Field>
          <Field label="Bill date">
            <input className="input" type="date" value={billDate} max={todayIso()} onChange={(e) => setBillDate(e.target.value)} />
          </Field>
          <Field label="Stock goes to">
            <select className="select" value={place?.id ?? ""} onChange={(e) => setPlaceId(e.target.value)}>
              {place ? null : <option value="">Choose a place</option>}
              {active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Transport charges" hint="Lorry or transport on this bill. Shared across the items by value.">
            <MoneyInput value={transport} placeholder="0" onChange={setTransport} />
          </Field>
        </div>

        {newSupplier ? (
          <div className="panel stack" style={{ gap: "var(--space-3)" }}>
            <strong>New supplier</strong>
            <div className="form-grid">
              <Field label="Name">
                <input className="input" value={newSupplier.name} maxLength={100} autoFocus onChange={(e) => setNewSupplier({ ...newSupplier, name: e.target.value })} />
              </Field>
              <Field label="Phone" hint="Optional">
                <input
                  className="input"
                  inputMode="tel"
                  value={newSupplier.phone}
                  maxLength={20}
                  onChange={(e) => setNewSupplier({ ...newSupplier, phone: e.target.value.replace(/[^\d\s+]/g, "") })}
                />
              </Field>
            </div>
            <div className="row">
              <Button size="sm" variant="primary" loading={createSupplier.isPending} disabled={newSupplier.name.trim().length < 2} onClick={() => createSupplier.mutate(newSupplier)}>
                Add supplier
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNewSupplier(null)}>Cancel</Button>
            </div>
          </div>
        ) : null}

        <Finder
          products={pickable}
          label="Add an item: type its name or code"
          meta={(p) => (p.cost_paise == null ? `no cost yet, per ${p.unit_name}` : `cost now ${rs(p.cost_paise)} / ${p.unit_name}`)}
          onPick={add}
        />
        {rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">How many</th>
                  <th className="num">Cost per unit</th>
                  <th className="num">Amount</th>
                  <th><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const unit = row.product?.unit_name ?? "";
                  const showError = row.error && (tried || !row.product);
                  return (
                    <tr key={row.key}>
                      <td>
                        {row.product?.name ?? "Unknown item"}
                        <span className="inv-sub">{row.product?.code}</span>
                        {showError ? <span className="inv-error">{row.error}</span> : null}
                      </td>
                      <td>
                        <div className="inv-qty">
                          <input
                            className="input"
                            inputMode="numeric"
                            value={row.qty}
                            aria-label={`How many ${row.product?.name ?? ""}`}
                            aria-invalid={(tried && !row.base) || undefined}
                            ref={(el) => {
                              if (el && focusKey.current === row.key) {
                                el.focus();
                                focusKey.current = null;
                              }
                            }}
                            onChange={(e) => update(row.key, { qty: digits(e.target.value, 6) })}
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
                      <td className="num">
                        <div className="inv-money">
                          <MoneyInput
                            value={row.cost}
                            ariaLabel={`Cost per ${unit} of ${row.product?.name ?? "item"}`}
                            invalid={(tried && row.cost === null) || undefined}
                            onChange={(cost) => update(row.key, { cost })}
                          />
                        </div>
                        <span className="inv-sub">per {unit}</span>
                      </td>
                      <td className="num">{row.cost === null || !row.base ? "—" : rs(row.amount)}</td>
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
          <p className="small muted">No items yet. Type an item name above and press Enter, or tap it. You can count by the bundle, but the cost is always for one unit, for example one Box.</p>
        )}

        <div className="split">
          <Field label="Note" hint="Optional">
            <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <dl className="kv">
            <dt>Goods</dt>
            <dd>{rs(goods)}</dd>
            <dt>Transport</dt>
            <dd>{rs(freight)}</dd>
            <dt>Bill total</dt>
            <dd style={{ fontSize: "var(--text-md)" }}>{rs(goods + freight)}</dd>
          </dl>
        </div>
        {problem ? <Notice tone="bad">{problem}</Notice> : tried && formError ? <Notice tone="bad">{formError}</Notice> : null}
      </div>
    </Dialog>
  );
}

function PurchaseDetails({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const products = useProducts().data ?? [];
  const unitOf = (id: number) => products.find((p) => p.id === id)?.unit_name ?? "";
  return (
    <Dialog open wide title={`Purchase ${purchase.bill_number || `#${purchase.id}`}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        <div className="split">
          <dl className="kv">
            <dt>Supplier</dt>
            <dd>{purchase.supplier || "No supplier"}</dd>
            <dt>Bill number</dt>
            <dd>{purchase.bill_number || "—"}</dd>
            <dt>Bill date</dt>
            <dd>{fmtDate(purchase.bill_date)}</dd>
          </dl>
          <dl className="kv">
            <dt>Stock went to</dt>
            <dd>{purchase.location}</dd>
            <dt>Entered by</dt>
            <dd>{purchase.user || "—"}</dd>
            <dt>Entered on</dt>
            <dd>{fmtDateTime(purchase.at)}</dd>
          </dl>
        </div>
        {purchase.note ? <p className="small">Note: {purchase.note}</p> : null}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Quantity</th>
                <th className="num">Cost per unit</th>
                <th className="num">With transport</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {purchase.lines.map((l) => (
                <tr key={l.product_id}>
                  <td>
                    {l.name}
                    <span className="inv-sub">{l.code}</span>
                  </td>
                  <td className="num">{l.quantity} {unitOf(l.product_id)}</td>
                  <td className="num">{rs(l.unit_cost_paise)}</td>
                  <td className="num">{rs(l.landed_unit_cost_paise)}</td>
                  <td className="num">{rs(l.quantity * l.unit_cost_paise)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>Goods</td>
                <td className="num">{rs(purchase.goods_paise)}</td>
              </tr>
              <tr>
                <td colSpan={4}>Transport</td>
                <td className="num">{rs(purchase.transport_paise)}</td>
              </tr>
              <tr>
                <td colSpan={4}>Bill total</td>
                <td className="num">{rs(purchase.total_paise)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="caption">“With transport” is the cost per unit after adding this item’s share of the transport. Item costs on the Products page use it.</p>
      </div>
    </Dialog>
  );
}

function SupplierDialog({ supplier, onClose }: { supplier: Supplier | null; onClose: () => void }) {
  const client = useQueryClient();
  const notify = useToast();
  const [name, setName] = useState(supplier?.name ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [gstin, setGstin] = useState(supplier?.gstin ?? "");
  const [tried, setTried] = useState(false);
  const nameError = name.trim().length < 2 ? "Enter the supplier name." : null;
  const gstinError = gstin && !/^[0-9A-Z]{15}$/.test(gstin) ? "A GSTIN has 15 letters and numbers." : null;

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), phone: phone.trim(), gstin };
      return supplier ? api.patch<Supplier>(`/api/suppliers/${supplier.id}`, body) : api.post<Supplier>("/api/suppliers", body);
    },
    onSuccess: (saved) => {
      invalidate(client, ["suppliers", "purchases"]);
      notify(supplier ? `Saved ${saved.name}.` : `Added ${saved.name}.`);
      onClose();
    },
    onError: (error) => notify(errorText(error), "bad"),
  });

  function submit() {
    setTried(true);
    if (!nameError && !gstinError) save.mutate();
  }

  const footer = (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={save.isPending} onClick={submit}>Save supplier</Button>
    </>
  );

  return (
    <Dialog open title={supplier ? `Change ${supplier.name}` : "Add supplier"} onClose={onClose} footer={footer}>
      <div className="stack">
        <Field label="Name" error={tried ? nameError : null}>
          <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Phone" hint="Optional">
          <input className="input" inputMode="tel" value={phone} maxLength={20} onChange={(e) => setPhone(e.target.value.replace(/[^\d\s+]/g, ""))} />
        </Field>
        <Field label="GSTIN" hint="Optional, 15 letters and numbers" error={tried ? gstinError : null}>
          <input className="input" value={gstin} maxLength={15} onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ""))} />
        </Field>
      </div>
    </Dialog>
  );
}

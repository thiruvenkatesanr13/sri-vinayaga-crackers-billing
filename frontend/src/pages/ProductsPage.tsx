import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, FileSpreadsheet, ImagePlus, Plus, Search, Trash2 } from "lucide-react";
import { api, errorText } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { pct, rs, rsShort } from "../lib/money";
import { useCategories, useLocations, useProducts, useSession, useSettings } from "../lib/session";
import type { Category, Location, Product } from "../lib/types";
import { Badge, Button, Dialog, Empty, Field, IconButton, Loading, MoneyInput, Notice, PageHead, Segmented, useToast } from "../components/ui";
import "../styles/inventory.css";

interface PreviewRow {
  row: number;
  name: string;
  category: string;
  added: number;
  removed: number;
  bundle: number | null;
  bundle_given: boolean;
  price_paise: number | null;
  flags: string[];
  errors: string[];
  action: "new" | "update" | "same";
  product: { id: number; code: string; name: string } | null;
  stock_add: number;
  stock_remove: number;
  /** Held back because the sheet still shows the same number as at the last import; used when Again is ticked. */
  repeat_add: number;
  repeat_remove: number;
  price_change: [number, number] | null;
  bundle_change: [number | null, number | null] | null;
}

interface ImportPreview {
  sha256: string;
  file_name: string;
  layout: "sheet" | "simple";
  imported_before_at: string | null;
  rows: PreviewRow[];
  categories: string[];
  flag_text: Record<string, string>;
  summary: { products: number; new: number; update: number; same: number; with_errors: number };
}

type ImportResult = {
  products_created: number;
  products_updated: number;
  products_unchanged: number;
  products_skipped: number;
  stock_added: number;
  stock_removed: number;
  stock_location: string;
};

interface Draft {
  name: string;
  categoryId: string;
  brand: string;
  unit: string;
  perCase: string;
  price: number | null;
  cost: number | null;
  low: string;
  active: boolean;
  giftBox: boolean;
  mode: "own" | "components";
}

const FLAG_LABEL: Record<string, string> = {
  category_guess: "Check category",
  maybe_cut: "Name may be cut",
  odd_end: "Name looks unfinished",
  duplicate: "Listed twice",
  no_stock: "Packed at sale",
};

const MODE_TEXT = {
  own: "Pre-packed: boxes are packed ahead and counted as their own stock.",
  components: "Packed at sale: packed when sold, so each sale takes the items inside out of shop stock.",
};

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
const digits = (text: string, max: number) => text.replace(/\D/g, "").slice(0, max);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const qtyAt = (product: Product, locationId: number) => product.stock[String(locationId)] ?? 0;
const packedAtSale = (product: Product) => product.is_gift_box && product.gift_box_mode === "components";
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const matches = (product: Product, words: string[]) => words.every((w) => `${product.name} ${product.code}`.toLowerCase().includes(w));

/** Active places, plus a closed place while some product still has stock there. */
function stockPlaces(locations: Location[], products: Product[]): Location[] {
  return locations.filter((l) => l.is_active || products.some((p) => qtyAt(p, l.id) !== 0));
}

/** Out / low at the billing shop, the stock that bills take from. */
function shopFlag(product: Product, lowDefault: number | null): "out" | "low" | null {
  if (!product.is_active || packedAtSale(product)) return null;
  if (product.sale_stock <= 0) return "out";
  const level = product.low_stock_level ?? lowDefault;
  return level !== null && product.sale_stock <= level ? "low" : null;
}

/** The product was saved, but a later step (items inside, photo) failed. */
class PartialSave extends Error {
  product: Product;
  constructor(product: Product, reason: unknown) {
    super(errorText(reason));
    this.product = product;
  }
}

function useMergeProduct() {
  const client = useQueryClient();
  return (product: Product) => {
    client.setQueryData<Product[]>(["products"], (list) =>
      list && (list.some((p) => p.id === product.id) ? list.map((p) => (p.id === product.id ? product : p)) : [...list, product]),
    );
    void client.invalidateQueries({ queryKey: ["products"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

function Thumb({ name, url, large }: { name: string; url: string | null; large?: boolean }) {
  const className = large ? "inv-photo" : "inv-thumb";
  if (url) return <img className={className} src={url} alt={large ? `Photo of ${name}` : ""} loading="lazy" />;
  return <span className={className} aria-hidden>{initials(name)}</span>;
}

function StockList({ product, places }: { product: Product; places: Location[] }) {
  if (packedAtSale(product)) return <><dt>Stock</dt><dd>Packed at sale</dd></>;
  return places.map((l) => (
    <Fragment key={l.id}>
      <dt>In {l.name}</dt>
      <dd>{qtyAt(product, l.id)} {product.unit_name}</dd>
    </Fragment>
  ));
}

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

export default function ProductsPage() {
  const { isOwner } = useSession();
  const productsQuery = useProducts();
  const categories = useCategories().data ?? [];
  const locationsQuery = useLocations();
  const lowDefault = useSettings().data?.low_stock_default ?? null;
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [showStopped, setShowStopped] = useState(false);
  const [dialog, setDialog] = useState<{ id: number | null; session: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importRun, setImportRun] = useState(0);
  const sessions = useRef(0);

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const places = useMemo(() => stockPlaces(locationsQuery.data ?? [], products), [locationsQuery.data, products]);
  const saleName = places.find((l) => l.is_sale_location)?.name;

  if (productsQuery.isPending || productsQuery.isError) {
    return (
      <div className="page inv">
        {productsQuery.isError ? <Notice tone="bad">{errorText(productsQuery.error)}</Notice> : <Loading label="Loading products" />}
      </div>
    );
  }

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const found = products.filter((p) => (!category || String(p.category_id) === category) && matches(p, words));
  const rows = showStopped ? found : found.filter((p) => p.is_active);
  const forSale = products.filter((p) => p.is_active).length;
  const stopped = products.length - forSale;
  const noCost = isOwner ? products.filter((p) => p.is_active && p.cost_paise == null).length : 0;
  const current = dialog?.id != null ? (products.find((p) => p.id === dialog.id) ?? null) : null;

  function open(id: number | null) {
    sessions.current += 1;
    setDialog({ id, session: sessions.current });
  }

  const importButton = (
    <Button onClick={() => setImporting(true)}>
      <FileSpreadsheet size={16} aria-hidden />
      Import from Excel
    </Button>
  );

  return (
    <div className="page inv">
      <PageHead
        title="Products"
        subtitle={`${forSale} for sale${stopped ? ` · ${stopped} stopped` : ""}${noCost ? ` · ${noCost} with no cost yet` : ""}`}
        actions={
          isOwner ? (
            <>
              {importButton}
              <Button variant="primary" onClick={() => open(null)}>
                <Plus size={16} aria-hidden />
                Add product
              </Button>
            </>
          ) : null
        }
      />

      {!products.length ? (
        <Empty title="No products yet">
          {isOwner ? "Import the shop’s product list from Excel, or add products one by one." : "The owner adds the product list here."}
          {isOwner ? <div className="row" style={{ justifyContent: "center", marginTop: "var(--space-4)" }}>{importButton}</div> : null}
        </Empty>
      ) : (
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
              <input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} />
              Show stopped items
            </label>
          </div>

          {rows.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th><span className="sr-only">Photo</span></th>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Category</th>
                    <th className="num">Price</th>
                    {places.map((l) => <th key={l.id} className="num">{l.is_active ? l.name : `${l.name} (closed)`}</th>)}
                    {places.length > 1 ? <th className="num">Total</th> : null}
                    <th className="num">Low at</th>
                    {isOwner ? <th className="num">Cost</th> : null}
                    {isOwner ? <th className="num">Margin</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const flag = shopFlag(p, lowDefault);
                    const packed = packedAtSale(p);
                    const margin = p.margin_bp ?? null;
                    return (
                      <tr key={p.id} className="clickable" tabIndex={0} onClick={() => open(p.id)} onKeyDown={(e) => e.key === "Enter" && open(p.id)}>
                        <td><Thumb name={p.name} url={p.photo_url} /></td>
                        <td className="muted inv-code">{p.code}</td>
                        <td>
                          <div className="inv-name">
                            <span>{p.name}</span>
                            {p.is_gift_box ? <Badge tone="gold">Gift box</Badge> : null}
                            {packed && !p.box_items.length ? <Badge tone="warn">Items not set</Badge> : null}
                            {p.is_active ? null : <Badge>Stopped</Badge>}
                          </div>
                          {p.brand ? <span className="inv-sub">{p.brand}</span> : null}
                        </td>
                        <td>{p.category_name}</td>
                        <td className="num">
                          {rsShort(p.price_paise)} <span className="muted">/ {p.unit_name}</span>
                          {p.case_price_paise ? <span className="inv-sub">{rsShort(p.case_price_paise)} / bundle of {p.units_per_case}</span> : null}
                        </td>
                        {places.map((l) => (
                          <td key={l.id} className="num">
                            {packed ? <span className="muted">{places.length > 1 ? "—" : "Packed at sale"}</span> : null}
                            {!packed && l.is_sale_location && flag ? <Badge tone={flag === "out" ? "bad" : "warn"}>{flag === "out" ? "Out" : "Low"}</Badge> : null}
                            {packed ? null : ` ${qtyAt(p, l.id)}`}
                          </td>
                        ))}
                        {places.length > 1 ? (
                          <td className="num">{packed ? <span className="muted">Packed at sale</span> : places.reduce((n, l) => n + qtyAt(p, l.id), 0)}</td>
                        ) : null}
                        <td className="num">
                          {p.low_stock_level ?? <span className="muted" title={lowDefault === null ? "No warning set" : "Shop default"}>{lowDefault ?? "—"}</span>}
                        </td>
                        {isOwner ? <td className="num">{p.cost_paise == null ? <span className="muted">Not set</span> : rs(p.cost_paise)}</td> : null}
                        {isOwner ? (
                          <td className="num">
                            {margin === null ? <span className="muted">—</span> : margin < 0 ? <span className="inv-delta down">−{pct(-margin)}</span> : pct(margin)}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No product matches">
              {found.length > rows.length
                ? `${found.length - rows.length} stopped item(s) match. Tick “Show stopped items” to see them.`
                : "Check the spelling, or choose another category."}
            </Empty>
          )}
          {rows.length ? (
            <p className="caption">
              {saleName ? `Low and Out are for ${saleName}, where bills take stock from. ` : ""}Tap a product to {isOwner ? "change it" : "see its details"}.
            </p>
          ) : null}
        </>
      )}

      {dialog && isOwner ? (
        <ProductEditor
          key={dialog.session}
          product={current}
          products={products}
          categories={categories}
          places={places}
          defaultCategory={category}
          lowDefault={lowDefault}
          onClose={() => setDialog(null)}
          onCreated={(id) => setDialog((d) => (d ? { ...d, id } : d))}
        />
      ) : null}
      {dialog && !isOwner && current ? (
        <ProductDetails product={current} products={products} places={places} lowDefault={lowDefault} onClose={() => setDialog(null)} />
      ) : null}
      {isOwner ? (
        <ImportDialog
          key={importRun}
          open={importing}
          onClose={() => setImporting(false)}
          onReset={() => setImportRun((n) => n + 1)}
          products={products}
          categories={categories}
          locations={locationsQuery.data ?? []}
        />
      ) : null}
    </div>
  );
}

type EditorProps = {
  product: Product | null;
  products: Product[];
  categories: Category[];
  places: Location[];
  defaultCategory: string;
  lowDefault: number | null;
  onClose: () => void;
  onCreated: (id: number) => void;
};

function ProductEditor({ product, products, categories, places, defaultCategory, lowDefault, onClose, onCreated }: EditorProps) {
  const notify = useToast();
  const client = useQueryClient();
  const merge = useMergeProduct();
  const [draft, setDraft] = useState<Draft>(() => ({
    name: product?.name ?? "",
    categoryId: product ? String(product.category_id) : defaultCategory,
    brand: product?.brand ?? "",
    unit: product?.unit_name ?? "Box",
    perCase: product ? String(product.units_per_case ?? "") : "",
    price: product?.price_paise ?? null,
    cost: product?.cost_paise ?? null,
    low: String(product?.low_stock_level ?? ""),
    active: product?.is_active ?? true,
    giftBox: product?.is_gift_box ?? false,
    mode: product?.gift_box_mode ?? "own",
  }));
  const [items, setItems] = useState(() => (product?.box_items ?? []).map((i) => ({ id: i.component_id, qty: String(i.quantity) })));
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [dropPhoto, setDropPhoto] = useState(false);
  const [tried, setTried] = useState(false);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [coarse] = useState(() => window.matchMedia("(pointer: coarse)").matches);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  useEffect(() => {
    const url = photo ? URL.createObjectURL(photo) : null;
    setPhotoUrl(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [photo]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const unit = tidy(draft.unit) || "Box";
  const perCaseOk = !draft.perCase || Number(draft.perCase) >= 2;
  const itemsValid = items.every((i) => Number(i.qty) >= 1);
  const errors = {
    name: tidy(draft.name).length < 2 ? "Enter the product name." : null,
    category: draft.categoryId ? null : "Choose a category.",
    price: draft.price ? null : "Enter the price.",
    perCase: perCaseOk ? null : "Use 2 or more, or leave it empty.",
    items: !draft.giftBox || itemsValid ? null : "Each item needs a quantity of 1 or more.",
  };
  const valid = Object.values(errors).every((e) => e === null);
  const err = (key: keyof typeof errors) => (tried ? errors[key] : null);
  const marginBp = draft.price && draft.cost !== null ? Math.floor(((draft.price - draft.cost) * 10000) / draft.price) : null;
  const shownPhoto = photoUrl ?? (dropPhoto ? null : (product?.photo_url ?? null));
  const candidates = products.filter((p) => p.is_active && !p.is_gift_box && p.id !== product?.id && !items.some((i) => i.id === p.id));
  const canPack =
    draft.giftBox && draft.mode === "components" && items.length && itemsValid
      ? Math.min(...items.map((i) => Math.floor((byId.get(i.id)?.sale_stock ?? 0) / Number(i.qty))))
      : null;
  const itemsKey = (list: { id: number; qty: number }[]) => list.map((i) => `${i.id}x${i.qty}`).sort().join(",");
  const itemsDirty =
    itemsKey(items.map((i) => ({ id: i.id, qty: Number(i.qty) }))) !== itemsKey((product?.box_items ?? []).map((i) => ({ id: i.component_id, qty: i.quantity })));

  const addCategory = useMutation({
    mutationFn: () => api.post<Category>("/api/categories", { name: tidy(newCategory ?? "") }),
    onSuccess: (created) => {
      client.setQueryData<Category[]>(["categories"], (list) => list && [...list, created]);
      void client.invalidateQueries({ queryKey: ["categories"] });
      set("categoryId", String(created.id));
      setNewCategory(null);
      notify(`Added the category ${created.name}.`);
    },
    onError: (error) => notify(errorText(error), "bad"),
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: tidy(draft.name),
        category_id: Number(draft.categoryId),
        brand: tidy(draft.brand),
        unit_name: unit,
        units_per_case: draft.perCase ? Number(draft.perCase) : null,
        price_paise: draft.price,
        cost_paise: draft.cost,
        low_stock_level: draft.low ? Number(draft.low) : null,
        is_active: draft.active,
        is_gift_box: draft.giftBox,
        gift_box_mode: draft.mode,
      };
      let saved = product ? await api.patch<Product>(`/api/products/${product.id}`, body) : await api.post<Product>("/api/products", body);
      try {
        if (saved.is_gift_box && itemsDirty) {
          const boxItems = items.map((i) => ({ component_id: i.id, quantity: Number(i.qty) }));
          saved = await api.put<Product>(`/api/products/${saved.id}/box-items`, { items: boxItems });
        }
        if (photo) {
          const form = new FormData();
          form.append("photo", photo);
          saved = await api.upload<Product>(`/api/products/${saved.id}/photo`, form);
        } else if (dropPhoto && saved.photo_url) {
          saved = await api.del<Product>(`/api/products/${saved.id}/photo`);
        }
      } catch (error) {
        throw new PartialSave(saved, error);
      }
      return saved;
    },
    onSuccess: (saved) => {
      merge(saved);
      notify(product ? `Saved ${saved.name}.` : `Added ${saved.code} ${saved.name}.`);
      onClose();
    },
    onError: (error) => {
      if (!(error instanceof PartialSave)) return notify(errorText(error), "bad");
      merge(error.product);
      if (!product) onCreated(error.product.id);
      notify(`${error.product.name} was saved, but this was not: ${error.message}`, "bad");
    },
  });

  function trySave() {
    setTried(true);
    if (valid) save.mutate();
  }

  function choosePhoto(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return notify("This file is not a photo. Use a JPG or PNG.", "bad");
    if (file.size > MAX_PHOTO_BYTES) return notify("This photo is too large. Use one under 5 MB.", "bad");
    setPhoto(file);
    setDropPhoto(false);
  }

  function addNewCategory() {
    if (tidy(newCategory ?? "").length >= 2 && !addCategory.isPending) addCategory.mutate();
  }

  const footer = (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={save.isPending} onClick={trySave}>
        {product ? "Save product" : "Add product"}
      </Button>
    </>
  );

  return (
    <Dialog open wide title={product ? `${product.code} · ${product.name}` : "Add product"} onClose={onClose} footer={footer}>
      <div className="stack">
        {tried && !valid ? <Notice tone="bad">Check the fields marked in red.</Notice> : null}
        <div className="split">
          <div className="inv-photo-row">
            <Thumb name={draft.name || "?"} url={shownPhoto} large />
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              <div className="row">
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  <ImagePlus size={14} aria-hidden />
                  {shownPhoto ? "Change photo" : "Add photo"}
                </Button>
                {coarse ? (
                  <Button size="sm" onClick={() => cameraRef.current?.click()}>
                    <Camera size={14} aria-hidden />
                    Take photo
                  </Button>
                ) : null}
                {shownPhoto ? (
                  <Button size="sm" variant="ghost" onClick={() => (photo ? setPhoto(null) : setDropPhoto(true))}>
                    <Trash2 size={14} aria-hidden />
                    Remove photo
                  </Button>
                ) : null}
                {dropPhoto ? <Button size="sm" variant="ghost" onClick={() => setDropPhoto(false)}>Keep photo</Button> : null}
              </div>
              <span className="small muted">
                {photo ? "The new photo is saved when you press Save." : dropPhoto ? "The photo is removed when you press Save." : "JPG or PNG, up to 5 MB."}
              </span>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => choosePhoto(e.target)} />
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => choosePhoto(e.target)} />
            </div>
          </div>
          {product ? (
            <dl className="kv">
              <StockList product={product} places={places} />
            </dl>
          ) : (
            <p className="small muted">The product code is made when you save.</p>
          )}
        </div>

        <div className="form-grid">
          <Field label="Name" error={err("name")}>
            <input className="input" value={draft.name} maxLength={120} autoFocus={!product} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <div className="stack" style={{ gap: "var(--space-1)" }}>
            <Field label="Category" error={err("category")}>
              <select className="select" value={draft.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
                <option value="" disabled>Choose a category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            {newCategory === null ? (
              <Button size="sm" variant="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setNewCategory("")}>
                <Plus size={14} aria-hidden />
                New category
              </Button>
            ) : (
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input
                  className="input"
                  value={newCategory}
                  maxLength={60}
                  placeholder="New category name"
                  aria-label="New category name"
                  autoFocus
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addNewCategory()}
                />
                <Button size="sm" loading={addCategory.isPending} disabled={tidy(newCategory).length < 2} onClick={addNewCategory}>Add</Button>
                <Button size="sm" variant="ghost" onClick={() => setNewCategory(null)}>Cancel</Button>
              </div>
            )}
          </div>
          <Field label="Brand" hint="Optional">
            <input className="input" value={draft.brand} maxLength={60} onChange={(e) => set("brand", e.target.value)} />
          </Field>
          <Field label="Unit" hint="How stock is counted, for example Box">
            <input className="input" value={draft.unit} maxLength={20} onChange={(e) => set("unit", e.target.value)} />
          </Field>
          <Field
            label="How many in a bundle"
            error={err("perCase")}
            hint={
              perCaseOk && draft.perCase && draft.price
                ? `Bundle price ${rs(draft.price * Number(draft.perCase))}. Billing gets a Bundle button.`
                : "“How many cases for a bundle” in the stock sheet. Leave empty if not sold as a bundle."
            }
          >
            <input className="input" inputMode="numeric" value={draft.perCase} onChange={(e) => set("perCase", digits(e.target.value, 4))} />
          </Field>
          <Field label={`Price per ${unit}`} error={err("price")}>
            <MoneyInput value={draft.price} invalid={!!err("price")} onChange={(paise) => set("price", paise)} />
          </Field>
          <Field label={`Cost per ${unit}`} hint={marginBp === null ? "What you pay. Only you see it. Purchases update it." : `Margin ${pct(marginBp)}. Only you see cost.`}>
            <MoneyInput value={draft.cost} placeholder="Not known yet" onChange={(paise) => set("cost", paise)} />
          </Field>
          <Field label="Low-stock level" hint={`Warn at or below this in the shop. Empty ${lowDefault === null ? "means no warning" : `uses the shop default, ${lowDefault}`}.`}>
            <input className="input" inputMode="numeric" value={draft.low} onChange={(e) => set("low", digits(e.target.value, 6))} />
          </Field>
        </div>

        <div className="split">
          <div className="field">
            <span>Status</span>
            <Segmented
              label="Status"
              value={draft.active ? "on" : "off"}
              onChange={(value) => set("active", value === "on")}
              options={[{ value: "on", label: "On sale" }, { value: "off", label: "Stopped" }]}
            />
            <small className="hint">Stopped items do not show in billing.</small>
          </div>
          <div className="field">
            <span>Gift box</span>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.giftBox}
                onChange={(e) => {
                  const on = e.target.checked;
                  setDraft((d) => ({ ...d, giftBox: on, perCase: on ? "" : d.perCase }));
                }}
              />
              This is a gift box
            </label>
            {draft.giftBox ? (
              <Segmented
                label="How this gift box uses stock"
                value={draft.mode}
                onChange={(value) => set("mode", value)}
                options={[{ value: "own", label: "Pre-packed" }, { value: "components", label: "Packed at sale" }]}
              />
            ) : null}
          </div>
        </div>

        {draft.giftBox ? (
          <section className="stack" style={{ gap: "var(--space-3)" }}>
            <div className="small muted">
              <p>{MODE_TEXT.own}</p>
              <p>{MODE_TEXT.components}</p>
            </div>
            <div className="spread">
              <h3>Items inside one box</h3>
              {canPack !== null ? <span className="small muted">Shop stock is enough to pack {canPack}</span> : null}
            </div>
            {draft.mode === "components" && !items.length ? (
              <Notice tone="warn">List the items inside. A packed-at-sale box cannot be billed until it has items.</Notice>
            ) : null}
            <Finder
              products={candidates}
              label="Add an item: type its name or code"
              meta={(p) => `${p.sale_stock} ${p.unit_name} in shop`}
              onPick={(p) => setItems((list) => [...list, { id: p.id, qty: "1" }])}
            />
            {items.length ? (
              <ul className="list">
                {items.map((line) => {
                  const item = byId.get(line.id);
                  const name = item?.name ?? "Item no longer listed";
                  return (
                    <li key={line.id}>
                      <span className="grow">{item ? `${item.code} · ${name}` : name}</span>
                      {item ? <span className="muted small">{item.sale_stock} in shop</span> : null}
                      <input
                        className="input inv-num-input"
                        inputMode="numeric"
                        value={line.qty}
                        aria-label={`How many ${name} in one box`}
                        aria-invalid={Number(line.qty) < 1 || undefined}
                        onChange={(e) => setItems((list) => list.map((i) => (i.id === line.id ? { ...i, qty: digits(e.target.value, 4) } : i)))}
                      />
                      <span className="small muted">per box</span>
                      <IconButton label={`Remove ${name}`} onClick={() => setItems((list) => list.filter((i) => i.id !== line.id))}>
                        <Trash2 size={16} />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {err("items") ? <p className="inv-error">{err("items")}</p> : null}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}

type DetailsProps = { product: Product; products: Product[]; places: Location[]; lowDefault: number | null; onClose: () => void };

function ProductDetails({ product, products, places, lowDefault, onClose }: DetailsProps) {
  const byId = new Map(products.map((p) => [p.id, p]));
  return (
    <Dialog open title={`${product.code} · ${product.name}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        <div className="inv-photo-row">
          <Thumb name={product.name} url={product.photo_url} large />
          <div className="row">
            {product.is_gift_box ? <Badge tone="gold">Gift box</Badge> : null}
            {product.is_active ? <Badge tone="good">On sale</Badge> : <Badge>Stopped</Badge>}
          </div>
        </div>
        <dl className="kv">
          <dt>Category</dt>
          <dd>{product.category_name}</dd>
          {product.brand ? <><dt>Brand</dt><dd>{product.brand}</dd></> : null}
          <dt>Price</dt>
          <dd>{rs(product.price_paise)} per {product.unit_name}</dd>
          {product.case_price_paise ? <><dt>Bundle price</dt><dd>{rs(product.case_price_paise)} for {product.units_per_case} {product.unit_name}</dd></> : null}
          <dt>Low-stock level</dt>
          <dd>{product.low_stock_level ?? lowDefault ?? "Not set"}</dd>
          <StockList product={product} places={places} />
        </dl>
        {product.is_gift_box ? (
          <section className="stack" style={{ gap: "var(--space-2)" }}>
            <h3>Items inside one box</h3>
            <p className="small muted">{MODE_TEXT[product.gift_box_mode]}</p>
            {product.box_items.length ? (
              <ul className="list">
                {product.box_items.map((i) => {
                  const item = byId.get(i.component_id);
                  return (
                    <li key={i.component_id}>
                      <span className="grow">{item ? `${item.code} · ${item.name}` : "Item no longer listed"}</span>
                      <span className="num">{i.quantity} {item?.unit_name ?? ""}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="small muted">The owner has not listed the items inside yet.</p>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}

type ImportProps = { open: boolean; onClose: () => void; onReset: () => void; products: Product[]; categories: Category[]; locations: Location[] };

const SHEET_COLUMNS = "Sparkle, QTY Removed, Qty Add, How many cases for a bundle and Final Price";

/** Stock sheet import. State lives until the import finishes; onReset remounts it for a fresh start. */
function ImportDialog({ open, onClose, onReset, products, categories, locations }: ImportProps) {
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [chosenCategory, setChosenCategory] = useState<Record<number, string>>({});
  const [skips, setSkips] = useState<Set<number>>(() => new Set());
  const [again, setAgain] = useState<Set<number>>(() => new Set());
  const [place, setPlace] = useState("");
  const [unit, setUnit] = useState("Box");
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const active = locations.filter((l) => l.is_active);
  const target = active.find((l) => String(l.id) === place);
  const saleShop = active.find((l) => l.is_sale_location);
  const keepStock = place === "none";
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const categoryOf = (r: PreviewRow) => chosenCategory[r.row] ?? r.category;

  const categoryNames = useMemo(() => {
    const seen = new Set<string>();
    return [...categories.map((c) => c.name), ...(preview?.categories ?? [])].filter((name) => {
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [categories, preview]);

  /** Per row: what is added and taken off (with Again ticked, last time's amounts too), and the stock in the
   *  chosen place before and after, worked out from the stock shown in the app. */
  const rows = useMemo(
    () =>
      (preview?.rows ?? []).map((r) => {
        const product = r.product ? byId.get(r.product.id) : undefined;
        const before = target && product ? qtyAt(product, target.id) : 0;
        const add = r.stock_add + (again.has(r.row) ? r.repeat_add : 0);
        const remove = r.stock_remove + (again.has(r.row) ? r.repeat_remove : 0);
        const moves = !keepStock && (add > 0 || remove > 0);
        const after = before + (keepStock ? 0 : add - remove);
        return { ...r, add, remove, before, after, moves, short: !!target && after < 0 };
      }),
    [preview, byId, target, keepStock, again],
  );
  const used = rows.filter((r) => !skips.has(r.row) && !r.errors.length);
  const plan = {
    created: used.filter((r) => r.action === "new").length,
    changed: used.filter((r) => r.action !== "new" && (r.price_change || r.bundle_change || r.moves)).length,
    added: keepStock ? 0 : used.reduce((sum, r) => sum + r.add, 0),
    removed: keepStock ? 0 : used.reduce((sum, r) => sum + r.remove, 0),
    short: used.filter((r) => r.short),
    noCategory: used.filter((r) => r.action === "new" && !tidy(categoryOf(r))),
    heldBack: keepStock ? 0 : used.filter((r) => (r.repeat_add || r.repeat_remove) && !again.has(r.row)).length,
  };
  const nothing = !plan.created && !plan.changed && !plan.added && !plan.removed;

  function close() {
    onClose();
    if (result) onReset();
  }

  const load = useMutation({
    mutationFn: (chosen: File) => {
      const form = new FormData();
      form.append("file", chosen);
      return api.upload<ImportPreview>("/api/import/preview", form);
    },
    onSuccess: (data) => {
      setPreview(data);
      setProblem(null);
      setSkips(new Set(data.rows.filter((r) => r.errors.length).map((r) => r.row)));
      setAgain(new Set());
    },
    onError: (error) => setProblem(errorText(error)),
  });

  const confirm = useMutation({
    mutationFn: (source: ImportPreview) =>
      api.post<ImportResult>("/api/import/confirm", {
        sha256: source.sha256,
        file_name: source.file_name,
        categories: Object.fromEntries(
          source.rows.filter((r) => r.action === "new" && chosenCategory[r.row]).map((r) => [r.row, tidy(chosenCategory[r.row])]),
        ),
        skip_rows: [...skips].sort((a, b) => a - b),
        again_rows: [...again].filter((row) => !skips.has(row)).sort((a, b) => a - b),
        location_id: keepStock ? null : Number(place),
        unit_name: tidy(unit) || "Box",
      }),
    onSuccess: (data) => {
      setResult(data);
      setProblem(null);
      for (const key of ["products", "categories", "dashboard", "stock-movements"]) void client.invalidateQueries({ queryKey: [key] });
    },
    onError: (error) => setProblem(errorText(error)),
  });

  function toggleSkip(row: number, on: boolean) {
    setSkips((current) => {
      const next = new Set(current);
      if (on) next.add(row);
      else next.delete(row);
      return next;
    });
  }

  function toggleAgain(row: number, on: boolean) {
    setAgain((current) => {
      const next = new Set(current);
      if (on) next.add(row);
      else next.delete(row);
      return next;
    });
  }

  const flagsInFile = [...new Set((preview?.rows ?? []).flatMap((r) => r.flags))];
  const errorRows = preview?.summary.with_errors ?? 0;
  const shown = rows.filter(
    (r) => !onlyChanges || r.action !== "same" || r.errors.length || r.flags.length || skips.has(r.row) || again.has(r.row),
  );
  // Said next to the Import button, so nobody is left guessing why it is grey.
  const importBlocker = !preview
    ? null
    : !place
      ? "Choose where the stock is added and taken off first."
      : plan.noCategory.length
        ? `${plural(plan.noCategory.length, "new item")} need a category.`
        : plan.short.length
          ? `${plural(plan.short.length, "item")} would go below zero in ${target?.name}. Fix the sheet or tick Skip.`
          : nothing
            ? "Nothing has changed since the last import."
            : null;
  const canImport = !!preview && !importBlocker;
  const title = "Import the stock sheet";

  if (result) {
    return (
      <Dialog open={open} wide title={title} onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
        <div className="stack">
          <Notice tone="good">Import finished.</Notice>
          <dl className="inv-figures">
            <div><dt>New items</dt><dd>{result.products_created}</dd></div>
            <div><dt>Items changed</dt><dd>{result.products_updated}</dd></div>
            <div><dt>Stock added</dt><dd>{result.stock_added.toLocaleString("en-IN")}</dd></div>
            <div><dt>Stock taken off</dt><dd>{result.stock_removed.toLocaleString("en-IN")}</dd></div>
          </dl>
          <p className="small">
            {result.stock_location ? `Stock changes are in ${result.stock_location}.` : "Stock was not changed; the sheet's numbers are noted as done."}
            {result.stock_location && saleShop && result.stock_location !== saleShop.name
              ? ` Bills take stock from ${saleShop.name}, so move what the shop needs on the Stock page.`
              : ""}
            {result.products_created ? " Add costs and low-stock levels on the new items." : ""}
          </p>
        </div>
      </Dialog>
    );
  }

  if (!preview) {
    const footer = (
      <>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!file} loading={load.isPending} onClick={() => file && load.mutate(file)}>Preview</Button>
      </>
    );
    return (
      <Dialog open={open} wide title={title} onClose={close} footer={footer}>
        <div className="stack">
          <p>
            Choose the stock sheet saved as an Excel (.xlsx) file, with the columns {SHEET_COLUMNS}, and a category name on its own row above
            each group.
          </p>
          <ul className="small" style={{ margin: 0, paddingLeft: "1.2em" }}>
            <li>
              <strong>Qty Add</strong> is added to the stock and <strong>QTY Removed</strong> is taken off. Type this time's amount: with 300
              in stock, Qty Add 50 makes it 350, and QTY Removed 50 makes it 250.
            </li>
            <li>
              Numbers that are the same as at the last import are not used again, so you never need to clear the sheet. If an item really got
              the same amount again, tick <strong>Again</strong> on it in the next step.
            </li>
            <li>
              <strong>QTY Removed</strong> is for stock taken out for other reasons, like damage. Bills already take sold stock off.
            </li>
            <li>
              <strong>How many cases for a bundle</strong>: how many pieces make one bundle, or Nil. You can also change it on each item here in
              Products.
            </li>
            <li>A price or bundle size changed here in the app stays until the sheet changes it.</li>
          </ul>
          <Field label="Excel file">
            <input
              className="input"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setProblem(null);
              }}
            />
          </Field>
          <p className="small muted">Nothing is saved yet. Next you see what changes for every item before importing.</p>
          {problem ? <Notice tone="bad">{problem}</Notice> : null}
        </div>
      </Dialog>
    );
  }

  const footer = (
    <>
      {importBlocker ? (
        <span className="dialog-note" role="status">
          {importBlocker}
        </span>
      ) : null}
      <Button onClick={close}>Close</Button>
      <Button variant="primary" disabled={!canImport} loading={confirm.isPending} onClick={() => confirm.mutate(preview)}>
        Import
      </Button>
    </>
  );

  return (
    <Dialog open={open} wide title={title} onClose={close} footer={footer}>
      <div className="stack">
        {preview.imported_before_at ? (
          <Notice>
            This same sheet was imported on {fmtDateTime(preview.imported_before_at)}. Its numbers were used then, so importing it again changes
            nothing unless you tick Again on an item.
          </Notice>
        ) : null}
        {preview.layout === "simple" ? (
          <Notice tone="warn">This sheet has no QTY Removed column, so its Qty is used as Qty Add.</Notice>
        ) : null}
        <div className="spread">
          <span className="small">File: <strong>{preview.file_name}</strong></span>
          <Button size="sm" variant="ghost" onClick={onReset}>Choose another file</Button>
        </div>
        <dl className="inv-figures">
          <div><dt>New items</dt><dd>{preview.summary.new}</dd></div>
          <div><dt>Items that change</dt><dd>{preview.summary.update}</dd></div>
          <div><dt>No change</dt><dd>{preview.summary.same}</dd></div>
          <div><dt>With errors</dt><dd>{errorRows}</dd></div>
        </dl>
        {errorRows ? (
          <Notice tone="bad">
            {errorRows === 1 ? "1 row has an error" : `${errorRows} rows have errors`} and will be skipped. Fix the sheet and import it again to
            bring {errorRows === 1 ? "it" : "them"} in.
          </Notice>
        ) : null}
        {flagsInFile.length ? (
          <ul className="inv-legend">
            {flagsInFile.map((flag) => (
              <li key={flag}>
                <Badge tone="warn">{FLAG_LABEL[flag] ?? flag}</Badge>
                <span>{preview.flag_text[flag] ?? ""}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="form-grid">
          <Field
            label="Add and take off stock at"
            hint={
              keepStock
                ? "Stock stays as it is. The sheet's numbers are noted as done, so the next import does not add them again."
                : place
                  ? `Qty Add goes into ${target?.name}, and QTY Removed comes out of it.`
                  : "Required. Pick the place that holds this stock."
            }
          >
            <select className="select" value={place} onChange={(e) => setPlace(e.target.value)}>
              <option value="" disabled>Choose a place</option>
              {active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              <option value="none">Don’t change stock</option>
            </select>
          </Field>
          {preview.summary.new ? (
            <Field label="Unit for new items" hint="What one Qty means, for example Box">
              <input className="input" value={unit} maxLength={20} onChange={(e) => setUnit(e.target.value)} />
            </Field>
          ) : null}
        </div>

        <div className="spread">
          <label className="check">
            <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
            Show only items that change or need a look
          </label>
          <span className="small muted">{skips.size} skipped</span>
        </div>
        {plan.heldBack ? (
          <p className="small muted">
            {plural(plan.heldBack, "item")} still {plan.heldBack === 1 ? "has" : "have"} the same Qty Add or QTY Removed as at the last import,
            so those numbers are not used again. If an item really got the same amount again, untick “Show only items that change” and tick
            Again on it.
          </p>
        ) : null}
        {shown.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Row</th>
                  <th>Item</th>
                  <th>Category</th>
                  <th>What changes</th>
                  <th className="num">{target ? `In ${target.name}` : "Stock"}</th>
                  <th>Skip</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const locked = r.errors.length > 0;
                  const skipped = skips.has(r.row);
                  const option = categoryNames.find((n) => n.toLowerCase() === tidy(categoryOf(r)).toLowerCase()) ?? "";
                  return (
                    <tr key={r.row} className={locked || (r.short && !skipped) ? "inv-row-error" : skipped ? "inv-row-skipped" : undefined}>
                      <td className="num">{r.row}</td>
                      <td>
                        {r.name || <span className="muted">No name</span>}
                        {r.product ? <span className="inv-sub">{r.product.code}</span> : null}
                        <div className="inv-tags">
                          {r.errors.map((e) => <Badge key={e} tone="bad">{e}</Badge>)}
                          {r.flags.map((flag) => (
                            <span key={flag} title={preview.flag_text[flag]}>
                              <Badge tone="warn">{FLAG_LABEL[flag] ?? flag}</Badge>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        {r.action === "new" && !locked ? (
                          <select className="select" value={option} disabled={skipped} aria-label={`Category in row ${r.row}`}
                            onChange={(e) => setChosenCategory((all) => ({ ...all, [r.row]: e.target.value }))}>
                            {option ? null : <option value="">Choose…</option>}
                            {categoryNames.map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        ) : (
                          r.category || "—"
                        )}
                      </td>
                      <td>
                        {locked ? null : (
                          <div className="inv-tags">
                            {r.action === "new" ? <Badge tone="gold">New item</Badge> : null}
                            {!keepStock && r.add ? <Badge tone="good">+{r.add.toLocaleString("en-IN")}</Badge> : null}
                            {!keepStock && r.remove ? <Badge tone="bad">−{r.remove.toLocaleString("en-IN")}</Badge> : null}
                            {r.price_change ? <Badge>Price {rsShort(r.price_change[0])} → {rsShort(r.price_change[1])}</Badge> : null}
                            {r.action === "new" && r.price_paise ? <Badge>Price {rsShort(r.price_paise)}</Badge> : null}
                            {r.bundle_change ? (
                              <Badge>{r.bundle_change[1] ? `Bundle of ${r.bundle_change[1]}` : "No bundle"}</Badge>
                            ) : r.action === "new" && r.bundle ? (
                              <Badge>Bundle of {r.bundle}</Badge>
                            ) : null}
                            {r.action !== "new" && !r.moves && !r.price_change && !r.bundle_change ? (
                              <span className="small muted">No change</span>
                            ) : null}
                            {!keepStock && (r.repeat_add || r.repeat_remove) ? (
                              <label className="check small" title="Same number as at the last import, so it is not used again. Tick if the same amount came in again.">
                                <input type="checkbox" checked={again.has(r.row)} disabled={skipped} onChange={(e) => toggleAgain(r.row, e.target.checked)} />
                                Again: {[r.repeat_add ? `add ${r.repeat_add}` : "", r.repeat_remove ? `take off ${r.repeat_remove}` : ""].filter(Boolean).join(", ")}
                              </label>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="num" style={{ whiteSpace: "nowrap" }}>
                        {!target || locked ? "—" : r.moves ? `${r.before} → ${r.after}` : r.before}
                        {r.short && !skipped ? <span className="inv-error">Only {r.before} there</span> : null}
                      </td>
                      <td>
                        <label className="check" title={locked ? "Rows with errors cannot be imported" : undefined}>
                          <input type="checkbox" checked={skipped} disabled={locked} aria-label={`Skip row ${r.row}`} onChange={(e) => toggleSkip(r.row, e.target.checked)} />
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Nothing changes">Every item matches the last import. Untick the box above to see every row.</Empty>
        )}
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
        {place ? (
          <p className="small">
            Will add <strong>{plural(plan.created, "new item")}</strong> and change <strong>{plural(plan.changed, "item")}</strong>
            {keepStock
              ? ", without changing stock."
              : `: ${plan.added.toLocaleString("en-IN")} added to and ${plan.removed.toLocaleString("en-IN")} taken off ${target?.name ?? "stock"}.`}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

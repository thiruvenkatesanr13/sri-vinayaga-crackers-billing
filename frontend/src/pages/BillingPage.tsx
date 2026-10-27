import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Gift, Minus, Pause, Pencil, Plus, Printer, ScreenShare, Search, Trash2, UserRound, X } from "lucide-react";
import { api, ApiError, errorText } from "../lib/api";
import { fmtDate, fmtTime } from "../lib/format";
import { computeTotals, paiseToInput, pct, rs, rsShort, toPaise } from "../lib/money";
import { printBill, useBillOutput } from "../lib/print";
import { useCategories, useProducts, useSession, useSettings } from "../lib/session";
import { uuid4 } from "../lib/uuid";
import {
  PAYMENT_MODES,
  type Bill,
  type Booking,
  type BookingSummary,
  type Customer,
  type DraftLine,
  type DraftPayload,
  type HeldBill,
  type Paged,
  type PaymentMode,
  type Product,
} from "../lib/types";
import { Badge, Button, Dialog, Empty, Field, IconButton, Loading, MoneyInput, Notice, Segmented, useToast } from "../components/ui";
import WhatsAppBillButton from "../components/WhatsAppBillButton";

type Draft = DraftPayload & { client_uuid: string };
type PayEntry = { amount: number | null; tendered: number | null; reference: string };

const BLANK_PAY: Record<PaymentMode, PayEntry> = {
  cash: { amount: null, tendered: null, reference: "" },
  upi: { amount: null, tendered: null, reference: "" },
  card: { amount: null, tendered: null, reference: "" },
  credit_card: { amount: null, tendered: null, reference: "" },
  bank: { amount: null, tendered: null, reference: "" },
};

function freshDraft(discountBp: number): Draft {
  return {
    client_uuid: uuid4(),
    lines: [],
    doc_type: "estimate",
    discount_bp: discountBp,
    customer_name: "",
    customer_phone: "",
    booking_id: null,
    booking_number: null,
    booking_advance_paise: 0,
  };
}

function loadDraft(key: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as Draft) : null;
    return parsed && Array.isArray(parsed.lines) && parsed.client_uuid ? parsed : null;
  } catch {
    return null;
  }
}

function useDraft(counterId: number | null, defaultDiscount: number) {
  const key = `svc.draft.${counterId ?? "none"}`;
  const [draft, setState] = useState<Draft>(() => loadDraft(key) ?? freshDraft(defaultDiscount));
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      setState(loadDraft(key) ?? freshDraft(defaultDiscount));
    }
  }, [key, defaultDiscount]);
  const setDraft = useCallback(
    (update: Draft | ((current: Draft) => Draft)) => {
      setState((current) => {
        const next = typeof update === "function" ? update(current) : update;
        window.localStorage.setItem(keyRef.current, JSON.stringify(next));
        return next;
      });
    },
    [],
  );
  return [draft, setDraft] as const;
}

function matches(product: Product, words: string[]): boolean {
  const hay = `${product.name} ${product.code}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function stockLabel(product: Product): { text: string; tone: "" | "low" | "out" } {
  if (product.is_gift_box && product.gift_box_mode === "components") return { text: "Packed at sale", tone: "" };
  const qty = product.sale_stock;
  if (qty <= 0) return { text: "Out of stock", tone: "out" };
  const level = product.low_stock_level ?? 5;
  return { text: `${qty} ${product.unit_name} left`, tone: qty <= level ? "low" : "" };
}

/** "+₹8.00" or "−₹8.00": an amount that can go either way. */
const signed = (paise: number) => (paise > 0 ? `+${rs(paise)}` : rs(paise));

/** The rate on a bill line. Tap it to type a different rate for this bill only; clearing it goes back to the item's price. */
function RateField({ rate, listRate, unit, onChange }: { rate: number; listRate: number; unit: string; onChange: (rate: number | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const edited = rate !== listRate;
  if (text !== null) {
    return (
      <span className="rate-edit">
        <input
          className="input"
          inputMode="decimal"
          aria-label={`Rate per ${unit} on this bill`}
          value={text}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setText(e.target.value);
            const value = toPaise(e.target.value);
            if (!e.target.value.trim()) onChange(null);
            else if (value !== null) onChange(value === listRate ? null : value);
          }}
          onBlur={() => setText(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              setText(null);
            }
          }}
        />
        <span>/ {unit}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`rate-button${edited ? " edited" : ""}`}
      title={edited ? `Changed on this bill. The item's price is ${rs(listRate)}.` : "Tap to change the rate on this bill"}
      onClick={() => setText(paiseToInput(rate))}
    >
      {rs(rate)} / {unit}
      {edited ? <s>{rs(listRate)}</s> : null}
    </button>
  );
}

export default function BillingPage() {
  const { counterId, counterName } = useSession();
  const { openCounterPicker } = useOutletContext<{ openCounterPicker: () => void }>();
  const settingsQuery = useSettings();
  const productsQuery = useProducts();
  const categoriesQuery = useCategories();
  const client = useQueryClient();
  const notify = useToast();
  const settings = settingsQuery.data;
  const onScreen = useBillOutput() === "screen";
  const BillIcon = onScreen ? ScreenShare : Printer;
  const [draft, setDraft] = useDraft(counterId, settings?.default_discount_bp ?? 0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<number | "all">("all");
  const [cursor, setCursor] = useState(0);
  const [customLabel, setCustomLabel] = useState<string | null>(null);
  const [modes, setModes] = useState<PaymentMode[]>(["cash"]);
  const [pay, setPay] = useState<Record<PaymentMode, PayEntry>>(BLANK_PAY);
  const [saved, setSaved] = useState<Bill | null>(null);
  const [problem, setProblem] = useState<ReactNode>(null);
  const [tab, setTab] = useState<"items" | "bill">("items");
  const [showCustomer, setShowCustomer] = useState(false);
  const [bookingPicker, setBookingPicker] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [otherDiscount, setOtherDiscount] = useState(false);
  const [totalText, setTotalText] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const payRef = useRef<HTMLDivElement>(null);

  // Apply the shop's default discount to a new, untouched bill once settings load.
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (!settings || defaultApplied.current) return;
    defaultApplied.current = true;
    if (draft.lines.length === 0 && draft.discount_bp === 0 && settings.default_discount_bp) {
      setDraft((d) => ({ ...d, discount_bp: settings.default_discount_bp }));
    }
  }, [settings, draft.lines.length, draft.discount_bp, setDraft]);

  // "Bill now" from the Bookings page opens here with ?booking=<id>.
  const [params, setParams] = useSearchParams();
  const bookingParam = params.get("booking");
  useEffect(() => {
    if (!bookingParam) return;
    setParams({}, { replace: true });
    if (draft.lines.length) {
      notify("Finish or hold the bill on screen first, then open the booking again.", "bad");
      return;
    }
    api
      .get<Booking>(`/api/bookings/${bookingParam}`)
      .then((booking) => loadBooking(booking))
      .catch((error) => notify(errorText(error), "bad"));
  }, [bookingParam]);

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const activeProducts = useMemo(() => products.filter((p) => p.is_active), [products]);

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    let list = activeProducts.filter((p) => (category === "all" || p.category_id === category) && matches(p, words));
    if (words.length) {
      const first = words[0];
      list = [...list].sort((a, b) => Number(!a.name.toLowerCase().startsWith(first)) - Number(!b.name.toLowerCase().startsWith(first)));
    }
    return list;
  }, [activeProducts, category, query]);

  useEffect(() => setCursor(0), [query, category]);

  const priced = useMemo(
    () =>
      draft.lines.map((line) => {
        const product = productMap.get(line.product_id);
        const factor = line.sale_unit === "case" ? (product?.units_per_case ?? 1) : 1;
        const listPrice = product ? product.price_paise * factor : 0;
        const unitPrice = line.rate_paise ?? listPrice;
        return { ...line, product, factor, listPrice, unitPrice, amount: unitPrice * line.qty, baseQty: line.qty * factor };
      }),
    [draft.lines, productMap],
  );

  const needed = useMemo(() => {
    const map = new Map<number, number>();
    for (const line of priced) map.set(line.product_id, (map.get(line.product_id) ?? 0) + line.baseQty);
    return map;
  }, [priced]);

  const subtotal = priced.reduce((sum, line) => sum + line.amount, 0);
  const gst = draft.doc_type === "gst";
  const totalOptions = {
    gstRateBp: gst ? settings?.gst_rate_bp : null,
    pricesIncludeGst: settings?.prices_include_gst,
    roundOff: settings?.round_off ?? true,
  };
  const workedOut = computeTotals(subtotal, draft.discount_bp, totalOptions).total_paise;
  // A typed total only counts while the bill is as it was when it was typed; changing items or the discount drops it.
  const typedTotal =
    draft.total_override_paise !== null && draft.total_override_paise !== undefined && draft.total_override_base === workedOut
      ? draft.total_override_paise
      : null;
  const totals = computeTotals(subtotal, draft.discount_bp, { ...totalOptions, totalPaise: typedTotal });
  const due = totals.total_paise - draft.booking_advance_paise;
  const unknownLines = priced.filter((l) => !l.product || !l.product.is_active);

  // One payment mode always covers the full amount; a newly added mode gets what is left.
  useEffect(() => {
    if (modes.length === 1) {
      const mode = modes[0];
      setPay((current) => (current[mode].amount === due ? current : { ...current, [mode]: { ...current[mode], amount: due } }));
    }
  }, [due, modes]);

  // Nothing here stops a bill from being saved: cash given that is less than the cash amount counts as what was
  // paid in cash, and whatever is not paid is saved on the bill as the balance due.
  const payments =
    due < 0
      ? [{ mode: "cash" as PaymentMode, amount_paise: due, cash_tendered_paise: null, reference: "" }]
      : modes
          .map((mode) => {
            const tendered = mode === "cash" ? pay.cash.tendered : null;
            const amount = pay[mode].amount ?? 0;
            return {
              mode,
              amount_paise: tendered !== null && tendered < amount ? tendered : amount,
              cash_tendered_paise: tendered,
              reference: pay[mode].reference,
            };
          })
          .filter((p) => p.amount_paise !== 0);
  const paid = payments.reduce((sum, p) => sum + p.amount_paise, 0);
  const remaining = due - paid;
  const cash = modes.includes("cash") ? pay.cash : null;
  const change = cash && cash.tendered !== null && cash.amount !== null && cash.tendered > cash.amount ? cash.tendered - cash.amount : null;

  const canSave = !!counterId && draft.lines.length > 0 && unknownLines.length === 0 && (!gst || !!settings?.gst_ready);

  function typeTotal(text: string) {
    const value = toPaise(text);
    if (!text.trim()) {
      setDraft((d) => ({ ...d, total_override_paise: null, total_override_base: null }));
    } else if (value !== null) {
      const total = value + draft.booking_advance_paise;
      setDraft((d) =>
        total === workedOut ? { ...d, total_override_paise: null, total_override_base: null } : { ...d, total_override_paise: total, total_override_base: workedOut },
      );
    }
  }

  const resetPayments = useCallback(() => {
    setModes(["cash"]);
    setPay(BLANK_PAY);
  }, []);

  const startNewBill = useCallback(() => {
    setSaved(null);
    setProblem(null);
    setCustomLabel(null);
    setShowCustomer(false);
    setTotalText(null);
    resetPayments();
    setDraft(freshDraft(settings?.default_discount_bp ?? 0));
    setTab("items");
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [resetPayments, setDraft, settings?.default_discount_bp]);

  function addProduct(product: Product, unit: "unit" | "case" = "unit") {
    if (saved) startNewBill();
    const group = customLabel ?? "";
    let key = "";
    setDraft((d) => {
      const index = d.lines.findIndex((l) => l.product_id === product.id && l.sale_unit === unit && l.group_label === group);
      if (index >= 0) {
        const lines = [...d.lines];
        lines[index] = { ...lines[index], qty: lines[index].qty + 1 };
        key = lines[index].key;
        return { ...d, lines };
      }
      key = uuid4();
      return { ...d, lines: [...d.lines, { key, product_id: product.id, sale_unit: unit, qty: 1, group_label: group }] };
    });
    window.setTimeout(() => setFlash(key), 0);
    setProblem(null);
  }

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  }

  function removeLine(key: string) {
    setDraft((d) => ({ ...d, lines: d.lines.filter((l) => l.key !== key) }));
  }

  function toggleMode(mode: PaymentMode) {
    if (modes.includes(mode)) {
      if (modes.length === 1) return;
      const next = modes.filter((m) => m !== mode);
      setModes(next);
      setPay((current) => ({ ...current, [mode]: { ...BLANK_PAY[mode] } }));
      return;
    }
    const others = modes.reduce((sum, m) => sum + (pay[m].amount ?? 0), 0);
    setModes([...modes, mode]);
    setPay((current) => ({ ...current, [mode]: { ...current[mode], amount: Math.max(0, due - others) } }));
  }

  // Held bills -------------------------------------------------------------
  const held = useQuery({
    queryKey: ["held", counterId],
    queryFn: () => api.get<HeldBill[]>(`/api/held-bills?counter=${counterId}`),
    enabled: !!counterId,
  });

  async function holdDraft(source: Draft, total: number) {
    await api.post("/api/held-bills", {
      counter_id: counterId,
      label: source.customer_name || `Bill at ${fmtTime(new Date().toISOString())}`,
      payload: source,
      total_paise: total,
    });
  }

  const hold = useMutation({
    mutationFn: () => holdDraft(draft, totals.total_paise),
    onSuccess: () => {
      notify("Bill put on hold.");
      startNewBill();
      void client.invalidateQueries({ queryKey: ["held", counterId] });
    },
    onError: (error) => notify(errorText(error), "bad"),
  });

  const resume = useMutation({
    mutationFn: async (target: HeldBill) => {
      await api.del(`/api/held-bills/${target.id}`);
      if (draft.lines.length) {
        try {
          await holdDraft(draft, totals.total_paise);
        } catch (error) {
          await holdDraft(target.payload as Draft, target.total_paise).catch(() => undefined);
          throw error;
        }
      }
      return target;
    },
    onSuccess: (target) => {
      const payload = target.payload as Draft;
      setSaved(null);
      setProblem(null);
      resetPayments();
      setCustomLabel(null);
      setDraft({ ...freshDraft(payload.discount_bp ?? 0), ...payload, client_uuid: payload.client_uuid || uuid4() });
      setTab("bill");
    },
    onError: (error) => notify(errorText(error), "bad"),
    onSettled: () => void client.invalidateQueries({ queryKey: ["held", counterId] }),
  });

  // Save ---------------------------------------------------------------------
  const save = useMutation({
    mutationFn: () =>
      api.post<Bill>("/api/bills", {
        client_uuid: draft.client_uuid,
        doc_type: draft.doc_type,
        counter_id: counterId,
        customer_name: draft.customer_name,
        customer_phone: draft.customer_phone,
        booking_id: draft.booking_id,
        discount_bp: draft.discount_bp,
        lines: draft.lines.map(({ product_id, sale_unit, qty, group_label, rate_paise }) => ({
          product_id,
          sale_unit,
          qty,
          group_label,
          rate_paise: rate_paise ?? null,
        })),
        total_override_paise: typedTotal,
        payments,
        expected_total_paise: totals.total_paise,
      }),
    onSuccess: async (bill) => {
      setSaved(bill);
      setProblem(null);
      setCustomLabel(null);
      setTotalText(null);
      resetPayments();
      setDraft(freshDraft(settings?.default_discount_bp ?? 0));
      setTab("bill");
      void client.invalidateQueries({ queryKey: ["products"] });
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      void client.invalidateQueries({ queryKey: ["bills"] });
      if (bill.booking_number) void client.invalidateQueries({ queryKey: ["bookings"] });
      try {
        await printBill(bill);
      } catch (error) {
        notify(`Bill saved, but printing failed: ${errorText(error)}`, "bad");
      }
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "insufficient_stock") {
        const items = (error.data.items as { name: string; available: number; unit: string }[]) ?? [];
        setProblem(
          <>
            Not enough stock in the shop:
            <ul style={{ margin: "var(--space-1) 0 0", paddingLeft: "1.2em" }}>
              {items.map((i) => (
                <li key={i.name}>
                  {i.name}: only {i.available} {i.unit} left
                </li>
              ))}
            </ul>
          </>,
        );
        void client.invalidateQueries({ queryKey: ["products"] });
      } else if (error instanceof ApiError && error.code === "price_changed") {
        setProblem("Prices changed since this bill was started. The new total is shown. Check it and save again.");
        void client.invalidateQueries({ queryKey: ["products"] });
      } else if (error instanceof ApiError && error.code === "no_counter") {
        openCounterPicker();
        setProblem(error.message);
      } else {
        setProblem(errorText(error));
      }
    },
  });

  const trySave = useCallback(() => {
    if (canSave && !save.isPending) save.mutate();
  }, [canSave, save]);

  // Keyboard ------------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (document.querySelector(".dialog")) return;
      if (event.key === "F2" || (event.key === "/" && !typing)) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === "F4") {
        event.preventDefault();
        if (draft.lines.length && !hold.isPending) hold.mutate();
      } else if (event.key === "F8") {
        event.preventDefault();
        setTab("bill");
        payRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      } else if (event.key === "F9" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        trySave();
      } else if (event.key === "Escape" && saved) {
        startNewBill();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft.lines.length, hold, saved, startNewBill, trySave]);

  // Fill in a returning customer's name from their phone number.
  useEffect(() => {
    const phone = draft.customer_phone.replace(/\D/g, "");
    if (phone.length !== 10 || draft.customer_name) return;
    let stale = false;
    api
      .get<Paged<Customer>>(`/api/customers?q=${phone}&limit=1`)
      .then((found) => {
        const match = found.results.find((c) => c.phone === phone);
        if (!stale && match?.name) setDraft((d) => (d.customer_name ? d : { ...d, customer_name: match.name }));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [draft.customer_phone, draft.customer_name, setDraft]);

  useEffect(() => {
    if (!flash) return;
    // Long bills scroll; keep the item just added or increased in view.
    document.querySelector<HTMLElement>('.lines .line[data-flash="true"]')?.scrollIntoView({ block: "nearest" });
    const timer = window.setTimeout(() => setFlash(null), 650);
    return () => window.clearTimeout(timer);
  }, [flash]);

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(filtered.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter" && !event.ctrlKey) {
      const product = filtered[cursor];
      if (product && !isBlocked(product)) {
        addProduct(product);
        setQuery("");
      }
    } else if (event.key === "Escape") {
      setQuery("");
    }
  }

  function isBlocked(product: Product) {
    return product.sale_stock <= 0 && !(product.is_gift_box && product.gift_box_mode === "components");
  }

  function startCustomBox() {
    const used = new Set(draft.lines.map((l) => l.group_label).filter(Boolean));
    let n = 1;
    while (used.has(`Custom Box ${n}`)) n += 1;
    setCustomLabel(`Custom Box ${n}`);
    notify(`Items you add now go into Custom Box ${n}.`);
  }

  function loadBooking(booking: Booking) {
    setBookingPicker(false);
    setSaved(null);
    setProblem(null);
    resetPayments();
    setDraft({
      ...freshDraft(settings?.default_discount_bp ?? 0),
      lines: booking.lines.map((l) => ({ key: uuid4(), product_id: l.product_id, sale_unit: l.sale_unit, qty: l.qty, group_label: "" })),
      customer_name: booking.customer_name,
      customer_phone: booking.customer_phone,
      booking_id: booking.id,
      booking_number: booking.number,
      booking_advance_paise: booking.advance_paise,
    });
    setTab("bill");
  }

  if (productsQuery.isPending || settingsQuery.isPending) {
    return (
      <div className="page">
        <Loading label="Loading products" />
      </div>
    );
  }
  if (productsQuery.isError) {
    return (
      <div className="page">
        <Notice tone="bad">{errorText(productsQuery.error)}</Notice>
      </div>
    );
  }

  const groups: { label: string; lines: typeof priced }[] = [];
  for (const line of priced) {
    const group = groups.find((g) => g.label === line.group_label);
    if (group) group.lines.push(line);
    else groups.push({ label: line.group_label, lines: [line] });
  }
  groups.sort((a, b) => Number(a.label !== "") - Number(b.label !== ""));
  const itemCount = draft.lines.reduce((n, l) => n + l.qty, 0);
  const discountChoices = [0, 500, 1000, settings?.default_discount_bp ?? 0]
    .filter((v, i, all) => all.indexOf(v) === i)
    .sort((a, b) => a - b);

  return (
    <div className="billing" data-tab={tab}>
      <section className="picker" aria-label="Products">
        <div className="search">
          <Search size={20} aria-hidden />
          <input
            ref={searchRef}
            className="input big"
            placeholder="Type item name or code"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            autoFocus
            aria-label="Search products"
          />
          <kbd>F2</kbd>
        </div>
        <div className="chips" role="group" aria-label="Category">
          <button type="button" className="chip" aria-pressed={category === "all"} onClick={() => setCategory("all")}>
            All
          </button>
          {(categoriesQuery.data ?? []).map((c) => (
            <button key={c.id} type="button" className="chip" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
        {customLabel ? (
          <Notice tone="warn">
            <span className="spread">
              <span>
                Adding to <strong>{customLabel}</strong>. Items are billed at their normal price.
              </span>
              <Button size="sm" onClick={() => setCustomLabel(null)}>
                Finish box
              </Button>
            </span>
          </Notice>
        ) : null}
        <div className="tiles" role="listbox" aria-label="Products to add">
          {filtered.map((product, index) => {
            const stock = stockLabel(product);
            const blocked = isBlocked(product);
            return (
              <button
                key={product.id}
                type="button"
                role="option"
                className="tile"
                aria-selected={query !== "" && index === cursor}
                disabled={blocked}
                onClick={() => addProduct(product)}
                title={blocked ? "Out of stock in the shop" : `Add 1 ${product.unit_name}`}
              >
                {product.photo_url ? (
                  <img src={product.photo_url} alt="" loading="lazy" />
                ) : (
                  <span className="thumb" aria-hidden>
                    {initials(product.name)}
                  </span>
                )}
                <span style={{ minWidth: 0 }}>
                  <span className="name">{product.name}</span>
                  <span className="meta">
                    <span className="price">{rsShort(product.price_paise)}</span>
                    <span>/ {product.unit_name}</span>
                    <span className={`stock ${stock.tone}`}>{stock.text}</span>
                  </span>
                </span>
              </button>
            );
          })}
          {!filtered.length ? (
            <div style={{ gridColumn: "1 / -1" }}>
              <Empty title={products.length ? "No item matches" : "No products yet"}>
                {products.length ? "Check the spelling, or pick another category." : "The owner can import the product list on the Products page."}
              </Empty>
            </div>
          ) : null}
        </div>
      </section>

      <section className="bill" aria-label="Current bill">
        {saved ? (
          <div className="saved">
            <Badge tone="good">Saved · {saved.number}</Badge>
            <div>
              <div className="muted small">Bill total</div>
              <div className="figure-wrap">
                <div className="figure">{rs(saved.total_paise)}</div>
                <span className="star-burst" key={saved.number} aria-hidden />
              </div>
            </div>
            {saved.payments.find((p) => p.change_paise) ? (
              <div className="change" style={{ fontSize: "var(--text-lg)" }}>
                Give change {rs(saved.payments.find((p) => p.change_paise)?.change_paise)}
              </div>
            ) : null}
            {saved.balance_paise > 0 ? (
              <div className="balance" style={{ fontSize: "var(--text-lg)" }}>
                Balance due {rs(saved.balance_paise)}
              </div>
            ) : saved.balance_paise < 0 ? (
              <div className="balance" style={{ fontSize: "var(--text-lg)" }}>
                Paid {rs(-saved.balance_paise)} more than the bill
              </div>
            ) : null}
            <div className="row" style={{ justifyContent: "center" }}>
              <Button onClick={() => printBill(saved).catch((e) => notify(errorText(e), "bad"))}>
                <BillIcon size={16} aria-hidden /> {onScreen ? "Show the bill" : "Print again"}
              </Button>
              <WhatsAppBillButton bill={saved} />
            </div>
            <Button variant="primary" size="lg" onClick={startNewBill} autoFocus>
              New bill <kbd>Esc</kbd>
            </Button>
          </div>
        ) : (
          <>
            <div className="bill-head">
              <div className="spread">
                <Segmented
                  label="Bill type"
                  value={draft.doc_type}
                  onChange={(value) => setDraft((d) => ({ ...d, doc_type: value }))}
                  options={[
                    { value: "estimate", label: "Estimate" },
                    {
                      value: "gst",
                      label: "GST invoice",
                      disabled: !settings?.gst_ready,
                      title: settings?.gst_ready ? undefined : "GSTIN, GST rate and HSN need to be set in Settings first",
                    },
                  ]}
                />
                {counterName ? <span className="muted small">{counterName}</span> : null}
              </div>
              {held.data?.length ? (
                <div className="held-tabs" aria-label="Bills on hold">
                  {held.data.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      className="held-tab"
                      onClick={() => resume.mutate(h)}
                      disabled={resume.isPending}
                      title={`Resume (held by ${h.user_name})`}
                    >
                      <Pause size={12} aria-hidden />
                      {h.label} · {rsShort(h.total_paise)}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="row">
                <Button size="sm" onClick={() => setShowCustomer((v) => !v)} aria-expanded={showCustomer}>
                  <UserRound size={14} aria-hidden />
                  {draft.customer_name || draft.customer_phone || "Customer"}
                </Button>
                <Button size="sm" onClick={() => setBookingPicker(true)} disabled={draft.lines.length > 0} title={draft.lines.length ? "Finish or hold this bill first" : undefined}>
                  <CalendarClock size={14} aria-hidden />
                  {draft.booking_number ?? "Booking"}
                </Button>
                <Button size="sm" onClick={() => (customLabel ? setCustomLabel(null) : startCustomBox())} aria-pressed={!!customLabel}>
                  <Gift size={14} aria-hidden />
                  {customLabel ? "Finish box" : "Custom box"}
                </Button>
                <Button size="sm" onClick={() => hold.mutate()} disabled={!draft.lines.length || hold.isPending}>
                  <Pause size={14} aria-hidden />
                  Hold <kbd>F4</kbd>
                </Button>
              </div>
              {showCustomer ? (
                <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  <Field label="Phone">
                    <input
                      className="input"
                      inputMode="tel"
                      value={draft.customer_phone}
                      onChange={(e) => setDraft((d) => ({ ...d, customer_phone: e.target.value.replace(/[^\d\s+]/g, "").slice(0, 14) }))}
                      placeholder="Optional"
                    />
                  </Field>
                  <Field label="Name">
                    <input
                      className="input"
                      value={draft.customer_name}
                      onChange={(e) => setDraft((d) => ({ ...d, customer_name: e.target.value.slice(0, 80) }))}
                      placeholder="Optional"
                    />
                  </Field>
                </div>
              ) : null}
              {!counterId ? (
                <Notice tone="warn">
                  <span className="spread">
                    Choose this laptop's counter before billing.
                    <Button size="sm" onClick={openCounterPicker}>
                      Choose counter
                    </Button>
                  </span>
                </Notice>
              ) : null}
            </div>

            <div className="lines">
              {!priced.length ? (
                <Empty title="Start a bill">
                  Tap an item, or type its name and press Enter.
                  <span className="small key-hints">
                    <br />
                    <kbd>F2</kbd> search · <kbd>F4</kbd> hold · <kbd>F8</kbd> payment · <kbd>F9</kbd> {onScreen ? "save & show" : "save & print"}
                  </span>
                </Empty>
              ) : null}
              {groups.map((group) => (
                <Fragment key={group.label || "main"}>
                  {group.label ? (
                    <div className="group-label spread">
                      <span>{group.label}</span>
                      <span className="num">{rs(group.lines.reduce((s, l) => s + l.amount, 0))}</span>
                    </div>
                  ) : null}
                  {group.lines.map((line) => {
                    const product = line.product;
                    const available = product?.sale_stock ?? 0;
                    const short =
                      product && !(product.is_gift_box && product.gift_box_mode === "components") && (needed.get(line.product_id) ?? 0) > available;
                    return (
                      <div className="line" key={line.key} data-flash={flash === line.key || undefined}>
                        <div className="info">
                          <div className="name" title={product?.name}>{product?.name ?? "Item no longer sold"}</div>
                          <div className="rate">
                            <RateField
                              rate={line.unitPrice}
                              listRate={line.listPrice}
                              unit={line.sale_unit === "case" ? `bundle of ${line.factor}` : (product?.unit_name ?? "unit")}
                              onChange={(rate) => updateLine(line.key, { rate_paise: rate })}
                            />
                            {short ? <span className="short">Only {available} in shop</span> : null}
                          </div>
                        </div>
                        <div className="controls">
                          <div className="qty">
                            <button type="button" aria-label="One less" onClick={() => (line.qty > 1 ? updateLine(line.key, { qty: line.qty - 1 }) : removeLine(line.key))}>
                              <Minus size={14} />
                            </button>
                            <input
                              aria-label="Quantity"
                              inputMode="numeric"
                              value={line.qty}
                              onChange={(e) => {
                                const qty = Number(e.target.value.replace(/\D/g, "").slice(0, 5));
                                if (qty > 0) updateLine(line.key, { qty });
                              }}
                            />
                            <button type="button" aria-label="One more" onClick={() => updateLine(line.key, { qty: line.qty + 1 })}>
                              <Plus size={14} />
                            </button>
                          </div>
                          {product?.units_per_case ? (
                            <div className="unit-toggle" role="group" aria-label="Unit">
                              <button type="button" aria-pressed={line.sale_unit === "unit"} onClick={() => updateLine(line.key, { sale_unit: "unit", rate_paise: null })}>
                                {product.unit_name}
                              </button>
                              <button type="button" aria-pressed={line.sale_unit === "case"} onClick={() => updateLine(line.key, { sale_unit: "case", rate_paise: null })}>
                                Bundle
                              </button>
                            </div>
                          ) : null}
                        </div>
                        <div className="amount">{rs(line.amount)}</div>
                        <div className="remove">
                          <IconButton label={`Remove ${product?.name ?? "item"}`} onClick={() => removeLine(line.key)}>
                            <Trash2 size={16} />
                          </IconButton>
                        </div>
                      </div>
                    );
                  })}
                </Fragment>
              ))}
            </div>

            {priced.length ? (
              <div className="bill-foot">
                {problem ? <Notice tone="bad">{problem}</Notice> : null}
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <span className="small muted">Discount</span>
                  <div className="segmented" role="group" aria-label="Discount on whole bill">
                    {discountChoices.map((bp) => (
                      <button
                        key={bp}
                        type="button"
                        aria-pressed={!otherDiscount && draft.discount_bp === bp}
                        onClick={() => {
                          setOtherDiscount(false);
                          setDraft((d) => ({ ...d, discount_bp: bp }));
                        }}
                      >
                        {pct(bp)}
                      </button>
                    ))}
                    <button type="button" aria-pressed={otherDiscount} onClick={() => setOtherDiscount(true)}>
                      Other
                    </button>
                  </div>
                  {otherDiscount ? (
                    <input
                      className="input"
                      style={{ width: 84, minHeight: 34 }}
                      inputMode="decimal"
                      aria-label="Discount percent"
                      placeholder="%"
                      defaultValue={draft.discount_bp ? draft.discount_bp / 100 : ""}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isFinite(value) && value >= 0 && value <= 100) setDraft((d) => ({ ...d, discount_bp: Math.round(value * 100) }));
                      }}
                    />
                  ) : null}
                </div>

                <div className="sums">
                  <span>Items total ({itemCount})</span>
                  <span className="num">{rs(totals.subtotal_paise)}</span>
                  {totals.discount_paise ? (
                    <>
                      <span>Discount {pct(draft.discount_bp)}</span>
                      <span className="num">−{rs(totals.discount_paise)}</span>
                    </>
                  ) : null}
                  {totals.adjustment_paise ? (
                    <>
                      <span>
                        Adjustment{" "}
                        <button type="button" className="link-button" onClick={() => typeTotal("")}>
                          Undo
                        </button>
                      </span>
                      <span className="num">{signed(totals.adjustment_paise)}</span>
                    </>
                  ) : null}
                  {gst ? (
                    <>
                      <span>GST {pct(settings?.gst_rate_bp ?? 0)} {settings?.prices_include_gst ? "(included)" : ""}</span>
                      <span className="num">{rs(totals.cgst_paise + totals.sgst_paise)}</span>
                    </>
                  ) : null}
                  {totals.round_off_paise ? (
                    <>
                      <span>Round off</span>
                      <span className="num">{rs(totals.round_off_paise)}</span>
                    </>
                  ) : null}
                  {draft.booking_advance_paise ? (
                    <>
                      <span>Advance paid ({draft.booking_number})</span>
                      <span className="num">−{rs(draft.booking_advance_paise)}</span>
                    </>
                  ) : null}
                </div>
                <div className="grand">
                  <span className="small muted">{draft.booking_advance_paise ? "To collect" : "Total"}</span>
                  {totalText !== null ? (
                    <input
                      className="input total-edit"
                      inputMode="decimal"
                      aria-label={draft.booking_advance_paise ? "Amount to collect" : "Bill total"}
                      value={totalText}
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => {
                        setTotalText(e.target.value);
                        typeTotal(e.target.value);
                      }}
                      onBlur={() => setTotalText(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") {
                          e.preventDefault();
                          setTotalText(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="figure figure-button"
                      title="Tap to type a different total"
                      onClick={() => setTotalText(paiseToInput(Math.max(due, 0)))}
                    >
                      {rs(due)}
                      <Pencil size={16} aria-hidden />
                    </button>
                  )}
                </div>

                {due > 0 ? (
                  <div className="stack" style={{ gap: "var(--space-2)" }} ref={payRef}>
                    <div className="pay-modes" role="group" aria-label="Payment modes">
                      {PAYMENT_MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          aria-pressed={modes.includes(m.value)}
                          aria-label={m.label}
                          title={m.short ? m.label : undefined}
                          onClick={() => toggleMode(m.value)}
                        >
                          {m.short ?? m.label}
                        </button>
                      ))}
                    </div>
                    {modes.map((mode) => (
                      <div className="pay-row" key={mode}>
                        <span>{PAYMENT_MODES.find((m) => m.value === mode)?.label}</span>
                        <MoneyInput
                          value={pay[mode].amount}
                          ariaLabel={`${mode} amount`}
                          onChange={(amount) => setPay((current) => ({ ...current, [mode]: { ...current[mode], amount } }))}
                        />
                        {mode === "cash" ? (
                          <span className="tendered">
                            <MoneyInput
                              value={pay.cash.tendered}
                              placeholder="Given"
                              ariaLabel="Cash given by customer"
                              onChange={(tendered) => setPay((current) => ({ ...current, cash: { ...current.cash, tendered } }))}
                            />
                          </span>
                        ) : (
                          <input
                            className="input"
                            placeholder="Ref (optional)"
                            aria-label={`${mode} reference`}
                            value={pay[mode].reference}
                            onChange={(e) => setPay((current) => ({ ...current, [mode]: { ...current[mode], reference: e.target.value.slice(0, 60) } }))}
                          />
                        )}
                        {modes.length > 1 ? (
                          <IconButton label={`Remove ${mode}`} onClick={() => toggleMode(mode)}>
                            <X size={14} />
                          </IconButton>
                        ) : (
                          <span />
                        )}
                      </div>
                    ))}
                    <div className="spread small">
                      {remaining > 0 ? (
                        <span className="balance">Balance due {rs(remaining)}</span>
                      ) : remaining < 0 ? (
                        <span className="balance">{rs(-remaining)} more than the bill</span>
                      ) : (
                        <span className="muted">Payments match the total</span>
                      )}
                      {change !== null ? <span className="change">Change {rs(change)}</span> : null}
                    </div>
                  </div>
                ) : due < 0 ? (
                  <Notice tone="warn">The advance is more than this bill. Return {rs(-due)} in cash to the customer.</Notice>
                ) : null}

                <Button variant="primary" size="lg" block onClick={trySave} disabled={!canSave} loading={save.isPending}>
                  <BillIcon size={18} aria-hidden />
                  {onScreen ? "Save & show" : "Save & print"} {rs(due)} <kbd>F9</kbd>
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>

      <div className="mobile-tabs">
        <button type="button" aria-pressed={tab === "items"} onClick={() => setTab("items")}>
          Items
        </button>
        <button type="button" aria-pressed={tab === "bill"} onClick={() => setTab("bill")}>
          Bill · {itemCount} · {rsShort(saved ? saved.total_paise : due)}
        </button>
      </div>

      <BookingPicker open={bookingPicker} onClose={() => setBookingPicker(false)} onPick={loadBooking} />
    </div>
  );
}

function BookingPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (b: Booking) => void }) {
  const [search, setSearch] = useState("");
  const notify = useToast();
  const list = useQuery({
    queryKey: ["bookings", "open"],
    queryFn: () => api.get<BookingSummary[]>("/api/bookings?status=open"),
    enabled: open,
  });
  const pick = useMutation({
    mutationFn: (id: number) => api.get<Booking>(`/api/bookings/${id}`),
    onSuccess: onPick,
    onError: (error) => notify(errorText(error), "bad"),
  });
  const rows = (list.data ?? []).filter((b) =>
    `${b.number} ${b.customer_name} ${b.customer_phone}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Dialog open={open} title="Bill a booking" onClose={onClose}>
      <div className="stack">
        <input className="input" placeholder="Search name, phone or booking number" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        {list.isPending ? <Loading /> : null}
        {list.data && !rows.length ? <Empty title="No open bookings" /> : null}
        <ul className="list">
          {rows.map((b) => (
            <li key={b.id}>
              <span className="grow">
                <strong>{b.customer_name}</strong> · {b.number} · due {fmtDate(b.delivery_date)}
              </span>
              <span className="num small">Advance {rsShort(b.advance_paise)}</span>
              <Button size="sm" onClick={() => pick.mutate(b.id)} loading={pick.isPending && pick.variables === b.id}>
                Use
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

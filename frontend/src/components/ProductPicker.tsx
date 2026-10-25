import { useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { rsShort } from "../lib/money";
import type { Product } from "../lib/types";

/** Type-to-find product box. Arrow keys + Enter, or click. */
export default function ProductPicker({
  products,
  onPick,
  placeholder = "Find item by name or code",
  exclude = [],
}: {
  products: Product[];
  onPick: (product: Product) => void;
  placeholder?: string;
  exclude?: number[];
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return products
      .filter((p) => p.is_active && !exclude.includes(p.id))
      .filter((p) => words.every((w) => `${p.name} ${p.code}`.toLowerCase().includes(w)))
      .slice(0, 8);
  }, [products, text, exclude]);

  function pick(product: Product) {
    onPick(product);
    setText("");
    setOpen(false);
    setCursor(0);
    inputRef.current?.focus();
  }

  return (
    <div className="picker-box">
      <div className="search">
        <Search size={16} aria-hidden />
        <input
          ref={inputRef}
          className="input"
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={open && results.length > 0}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setCursor(0);
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter" && results[cursor]) {
              e.preventDefault();
              pick(results[cursor]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {open && results.length ? (
        <ul className="picker-results" role="listbox">
          {results.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === cursor}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
                <span className="grow">
                  {p.name} <span className="muted small">{p.code}</span>
                </span>
                <span className="num small">{rsShort(p.price_paise)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

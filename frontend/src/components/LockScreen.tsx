import { useEffect, useRef, useState } from "react";
import { brand } from "../lib/brand";
import { fmtClock, fmtLongDate } from "../lib/format";

const OPEN_MS = 220; // same as --dur-panel

/** Shown after logout: a dark screen with the shop's mark and the time, until someone taps or presses a key. */
export default function LockScreen({ shopName, onOpen }: { shopName: string; onOpen: () => void }) {
  const [now, setNow] = useState(() => new Date());
  const [opening, setOpening] = useState(false);
  const opened = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const open = () => {
      if (opened.current) return;
      opened.current = true;
      setOpening(true);
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.setTimeout(onOpen, reduce ? 0 : OPEN_MS);
    };
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", open);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", open);
    };
  }, [onOpen]);

  return (
    <main className={`lock${opening ? " opening" : ""}`} aria-label="Screen locked">
      <div className="lock-face">
        <img className="lock-mark" src={brand.mark} alt="" width={96} height={96} />
        <div className="lock-time" aria-live="off">
          {fmtClock(now)}
        </div>
        <div className="lock-date">{fmtLongDate(now)}</div>
        <div className="lock-shop">{shopName}</div>
      </div>
      <p className="lock-hint">Logged out. Tap anywhere or press any key to log in.</p>
    </main>
  );
}

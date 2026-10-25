import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Delete } from "lucide-react";
import { api, errorText } from "../lib/api";
import { brand } from "../lib/brand";
import { isLocked, unlock } from "../lib/session";
import type { Bootstrap } from "../lib/types";
import { Button, Notice } from "../components/ui";
import LockScreen from "../components/LockScreen";

export default function LoginPage({ boot }: { boot: Bootstrap }) {
  const client = useQueryClient();
  const [locked, setLocked] = useState(isLocked);
  const [fromLock, setFromLock] = useState(false);
  const [userId, setUserId] = useState<number | null>(boot.users.length === 1 ? boot.users[0].id : null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const user = boot.users.find((u) => u.id === userId);
  // Owner PINs are at least 6 digits and staff PINs at least 4, so the dots start at that many.
  const shortest = user?.role === "owner" ? 6 : 4;

  const submit = useCallback(
    async (value: string) => {
      if (!userId || value.length < shortest || busy) return;
      setBusy(true);
      setError(null);
      try {
        const next = await api.post<Bootstrap>("/api/auth/login", { user_id: userId, pin: value });
        client.setQueryData(["bootstrap"], next);
      } catch (err) {
        setError(errorText(err));
        setPin("");
      } finally {
        setBusy(false);
      }
    },
    [userId, shortest, busy, client],
  );

  const press = useCallback(
    (digit: string) => {
      setError(null);
      setPin((current) => (current.length >= 8 ? current : current + digit));
    },
    [],
  );

  useEffect(() => {
    // The previous person's screens are gone; forget their data so the next person starts fresh.
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== "bootstrap" });
  }, [client]);

  useEffect(() => {
    if (!userId || locked) return;
    const onKey = (event: KeyboardEvent) => {
      if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (event.key === "Enter") void submit(pin);
      else if (event.key === "Escape") {
        setPin("");
        setUserId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [userId, locked, pin, press, submit]);

  const openLock = useCallback(() => {
    unlock();
    setLocked(false);
    setFromLock(true);
  }, []);

  if (locked) return <LockScreen shopName={boot.shop_name} onOpen={openLock} />;

  return (
    <div className={`gate${fromLock ? " from-lock" : ""}`}>
      <section className="gate-side">
        <div className="gate-brand">
          <img className="shop-logo" src={brand.logo} alt={boot.shop_name} width={240} height={240} />
          {boot.shop_name_tamil ? <div className="tamil">{boot.shop_name_tamil}</div> : null}
          {boot.tagline ? <p className="muted">{boot.tagline}</p> : null}
        </div>
        <p className="side-note muted small">Billing runs on this shop's own computer. It keeps working when the internet is down.</p>
      </section>
      <main className="gate-main">
        <div className="gate-card">
          {!user ? (
            <>
              <h1>Who is billing?</h1>
              <div className="people">
                {boot.users.map((u) => (
                  <button key={u.id} type="button" className="person" onClick={() => setUserId(u.id)}>
                    {u.name}
                    <small>{u.role === "owner" ? "Owner" : "Staff"}</small>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="spread">
                <h1>Hello, {user.name}</h1>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setUserId(null);
                    setPin("");
                    setError(null);
                  }}
                >
                  Not you?
                </Button>
              </div>
              <p className="muted">Enter your PIN</p>
              <div className="pin-dots" aria-label={`${pin.length} digits entered`}>
                {Array.from({ length: Math.max(shortest, pin.length) }).map((_, i) => (
                  <span key={i} className={i < pin.length ? "on" : ""} />
                ))}
              </div>
              {error ? <Notice tone="bad">{error}</Notice> : null}
              <div className="pinpad">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                  <button key={d} type="button" onClick={() => press(d)}>
                    {d}
                  </button>
                ))}
                <button type="button" aria-label="Delete last digit" onClick={() => setPin((p) => p.slice(0, -1))}>
                  <Delete size={20} style={{ margin: "auto" }} />
                </button>
                <button type="button" onClick={() => press("0")}>
                  0
                </button>
                <button type="button" onClick={() => void submit(pin)} disabled={pin.length < shortest || busy} aria-label="Log in">
                  {busy ? "…" : "OK"}
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

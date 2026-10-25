import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../lib/api";
import { brand } from "../lib/brand";
import type { Bootstrap } from "../lib/types";
import { Button, Field, Notice } from "../components/ui";

export default function SetupPage() {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const mismatch = pin2.length > 0 && pin !== pin2;
  const ready = name.trim().length >= 2 && /^\d{6,8}$/.test(pin) && pin === pin2;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      const boot = await api.post<Bootstrap>("/api/setup", { owner_name: name, pin });
      client.setQueryData(["bootstrap"], boot);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="gate">
      <section className="gate-side">
        <div className="gate-brand">
          <img className="shop-logo" src={brand.logo} alt="Sri Vinayaga Crackers" width={240} height={240} />
          <div className="tamil">ஸ்ரீ விநாயகா கிராக்கர்ஸ்</div>
        </div>
        <p className="side-note muted">
          First-time setup for the billing laptop. It keeps the shop's bills and stock. The second counter opens billing
          from this laptop over the shop Wi-Fi.
        </p>
      </section>
      <main className="gate-main">
        <form className="gate-card" onSubmit={submit}>
          <div>
            <h1>Set up this PC</h1>
            <p className="muted" style={{ marginTop: "var(--space-1)" }}>
              Takes a minute. Only the owner does this, once.
            </p>
          </div>

          <Field label="Owner name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Owner PIN" hint="6 to 8 digits. Not 123456 or the same digit repeated.">
            <input
              className="input"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
              autoComplete="new-password"
            />
          </Field>
          <Field label="PIN again" error={mismatch ? "The two PINs are different." : null}>
            <input
              className="input"
              type="password"
              inputMode="numeric"
              value={pin2}
              aria-invalid={mismatch || undefined}
              onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 8))}
              autoComplete="new-password"
            />
          </Field>
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Button type="submit" variant="primary" size="lg" disabled={!ready} loading={saving}>
            Finish setup
          </Button>
        </form>
      </main>
    </div>
  );
}

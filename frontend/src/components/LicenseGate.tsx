import { useState } from "react";
import { api, errorText } from "../lib/api";
import { brand } from "../lib/brand";
import type { Bootstrap } from "../lib/types";
import { Button, Notice } from "./ui";

/** Shown full-screen when the licence has ended. The app does nothing else until an admin
 *  renewal key is pasted, so the shop simply contacts the admin to troubleshoot. */
export default function LicenseGate({ boot }: { boot: Bootstrap }) {
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock() {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post<Bootstrap>("/api/license", { key: key.trim() });
      window.location.reload();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="gate-main" style={{ minHeight: "100dvh" }}>
      <div className="gate-card" style={{ textAlign: "center", maxWidth: 440 }}>
        <img className="shop-logo" src={brand.logo} alt={boot.shop_name} width={120} height={120} style={{ margin: "0 auto" }} />
        <h1>{boot.shop_name}</h1>
        <Notice tone="bad">This software is not licensed to run. Contact the admin to troubleshoot.</Notice>
        {showKey ? (
          <div style={{ display: "grid", gap: "0.75rem", textAlign: "left" }}>
            <label className="muted small" htmlFor="license-key">
              Paste the renewal key from the admin
            </label>
            <textarea
              id="license-key"
              className="textarea"
              rows={4}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              spellCheck={false}
              style={{ fontFamily: "monospace", resize: "vertical" }}
            />
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <Button variant="primary" block loading={busy} disabled={!key.trim()} onClick={() => void unlock()}>
              Unlock
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setShowKey(true)}>
            I have a renewal key from the admin
          </Button>
        )}
      </div>
    </div>
  );
}

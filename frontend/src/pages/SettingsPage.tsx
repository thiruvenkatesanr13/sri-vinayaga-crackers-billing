import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, KeyRound, Plus } from "lucide-react";
import { api, errorText } from "../lib/api";
import { fmtDateTime, isToday } from "../lib/format";
import { useLocations, useSession, useSettings } from "../lib/session";
import type { BackupStatus, Counter, Location, Role, Settings } from "../lib/types";
import { Badge, Button, Dialog, Empty, Field, Loading, Notice, PageHead, Segmented, Tabs, useToast } from "../components/ui";

type Tab = "shop" | "bills" | "people" | "places" | "backup" | "whatsapp" | "activity";

interface Person {
  id: number;
  name: string;
  role: Role;
  is_active: boolean;
  locked: boolean;
}

interface BackupInfo {
  status: BackupStatus;
  local_folder: string;
  drive_folder: string;
  backups: {
    file: string;
    kind: "hourly" | "day" | "older";
    size: number;
    excel: string | null;
    excel_size: number | null;
    taken_at: string | null;
  }[];
}

const KIND_LABEL = { hourly: "Hourly", day: "Day", older: "Older" } as const;

function kb(bytes: number | null): string {
  return bytes === null ? "" : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-IN")} KB`;
}

function percentText(bp: number | null | undefined): string {
  return bp === null || bp === undefined ? "" : String(bp / 100);
}

function toBp(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : NaN;
}

/** Edits a copy of the settings and saves only what changed. */
function useSettingsForm() {
  const settings = useSettings();
  const client = useQueryClient();
  const notify = useToast();
  const [changes, setChanges] = useState<Partial<Settings>>({});
  const value = <K extends keyof Settings>(key: K): Settings[K] =>
    (key in changes ? changes[key] : settings.data?.[key]) as Settings[K];
  const set = <K extends keyof Settings>(key: K, next: Settings[K]) => setChanges((c) => ({ ...c, [key]: next }));
  const save = useMutation({
    mutationFn: () => api.patch<Settings>("/api/settings", changes),
    onSuccess: (saved) => {
      client.setQueryData(["settings"], saved);
      void client.invalidateQueries({ queryKey: ["bootstrap"] });
      void client.invalidateQueries({ queryKey: ["locations"] });
      void client.invalidateQueries({ queryKey: ["backups"] });
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      setChanges({});
      notify("Settings saved.");
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  return { settings, value, set, dirty: Object.keys(changes).length > 0, save, reset: () => setChanges({}) };
}

type Form = ReturnType<typeof useSettingsForm>;

function SaveBar({ form }: { form: Form }) {
  return (
    <div className="row" style={{ marginTop: "var(--space-5)" }}>
      <Button variant="primary" disabled={!form.dirty} loading={form.save.isPending} onClick={() => form.save.mutate()}>
        Save changes
      </Button>
      {form.dirty ? (
        <Button variant="ghost" onClick={form.reset}>
          Undo changes
        </Button>
      ) : null}
    </div>
  );
}

function Text({ form, name, label, hint, multiline }: { form: Form; name: keyof Settings; label: string; hint?: ReactNode; multiline?: boolean }) {
  const current = (form.value(name) as string | null) ?? "";
  return (
    <Field label={label} hint={hint}>
      {multiline ? (
        <textarea className="textarea" rows={3} value={current} onChange={(e) => form.set(name, e.target.value as never)} />
      ) : (
        <input className="input" value={current} onChange={(e) => form.set(name, e.target.value as never)} />
      )}
    </Field>
  );
}

function Percent({ form, name, label, hint, allowEmpty }: { form: Form; name: keyof Settings; label: string; hint?: ReactNode; allowEmpty?: boolean }) {
  const [text, setText] = useState(percentText(form.value(name) as number | null));
  const bp = toBp(text);
  const invalid = Number.isNaN(bp) || (!allowEmpty && bp === null);
  return (
    <Field label={label} hint={hint} error={invalid ? "Enter a number like 10 or 12.5" : null}>
      <input
        className="input"
        inputMode="decimal"
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const next = toBp(e.target.value);
          if (!Number.isNaN(next) && (allowEmpty || next !== null)) form.set(name, next as never);
        }}
      />
    </Field>
  );
}

function ShopTab() {
  const form = useSettingsForm();
  if (!form.settings.data) return <Loading />;
  return (
    <section>
      <p className="muted small" style={{ marginBottom: "var(--space-4)" }}>
        Printed at the top and bottom of every bill. Old bills keep the details they were printed with.
      </p>
      <div className="form-grid">
        <Text form={form} name="shop_name" label="Shop name" />
        <Text form={form} name="shop_name_tamil" label="Shop name in Tamil" />
        <Text form={form} name="tagline" label="Tagline" />
        <Text form={form} name="phones" label="Phone numbers" />
      </div>
      <div className="form-grid" style={{ marginTop: "var(--space-4)" }}>
        <Text form={form} name="address" label="Address" multiline />
        <Text form={form} name="bank_details" label="Bank details" hint="Bank, account name, account number, IFSC." multiline />
      </div>
      <div className="form-grid" style={{ marginTop: "var(--space-4)" }}>
        <Text form={form} name="upi_id" label="UPI ID" hint="Printed on the bill when filled." />
        <Text form={form} name="footer_terms" label="Bill footer line 1" />
        <Text form={form} name="footer_thanks" label="Bill footer line 2" />
      </div>
      <SaveBar form={form} />
    </section>
  );
}

function BillsTab() {
  const form = useSettingsForm();
  const s = form.settings.data;
  if (!s) return <Loading />;
  const includes = form.value("prices_include_gst");
  return (
    <section className="stack">
      <h2>Bill numbers</h2>
      <div className="form-grid">
        <Text form={form} name="estimate_prefix" label="Estimate number starts with" hint={`Next looks like ${form.value("estimate_prefix")}00001`} />
        <Text form={form} name="gst_prefix" label="GST invoice number starts with" />
        <Text form={form} name="booking_prefix" label="Booking number starts with" />
      </div>
      <p className="caption">Changing a prefix starts a new series from 00001. Numbers are never reused.</p>

      <h2 style={{ marginTop: "var(--space-4)" }}>Discount and rounding</h2>
      <div className="form-grid">
        <Percent
          form={form}
          name="default_discount_bp"
          label="Discount already applied on a new bill (%)"
          hint="Billers can give any discount from 0% to 100% on each bill."
        />
        <Field label="Low stock warning at (units)" hint="Used when a product has no level of its own.">
          <input
            className="input"
            inputMode="numeric"
            value={form.value("low_stock_default") ?? ""}
            onChange={(e) => form.set("low_stock_default", e.target.value ? Number(e.target.value.replace(/\D/g, "")) : null)}
          />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.value("round_off")} onChange={(e) => form.set("round_off", e.target.checked)} />
        Round the bill total to the nearest rupee
      </label>

      <h2 style={{ marginTop: "var(--space-4)" }}>GST</h2>
      {s.gst_ready ? (
        <Notice tone="good">GST invoices are ready to use.</Notice>
      ) : (
        <Notice tone="warn">GST invoices stay switched off until the GSTIN, GST rate and price type are filled. Confirm these with your accountant.</Notice>
      )}
      <div className="form-grid">
        <Text form={form} name="gstin" label="GSTIN" />
        <Percent form={form} name="gst_rate_bp" label="GST rate (%)" allowEmpty hint="Leave empty until confirmed." />
        <Text form={form} name="hsn_code" label="HSN code" />
        <Field label="Product prices">
          <select
            className="select"
            value={includes === null ? "" : includes ? "yes" : "no"}
            onChange={(e) => form.set("prices_include_gst", e.target.value === "" ? null : e.target.value === "yes")}
          >
            <option value="">Not confirmed yet</option>
            <option value="yes">Include GST</option>
            <option value="no">GST is added on top</option>
          </select>
        </Field>
      </div>
      <SaveBar form={form} />
    </section>
  );
}

function PersonDialog({ person, onClose }: { person: Person | "new"; onClose: () => void }) {
  const client = useQueryClient();
  const notify = useToast();
  const existing = person === "new" ? null : person;
  const [name, setName] = useState(existing?.name ?? "");
  const [role, setRole] = useState<Role>(existing?.role ?? "staff");
  const [active, setActive] = useState(existing?.is_active ?? true);
  const [pin, setPin] = useState("");
  const shortest = role === "owner" ? 6 : 4;
  const pinOk = existing ? pin === "" || (pin.length >= shortest && pin.length <= 8) : pin.length >= shortest && pin.length <= 8;
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.patch(`/api/users/${existing.id}`, { name, role, is_active: active, ...(pin ? { pin } : {}) })
        : api.post("/api/users", { name, role, pin }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["users"] });
      void client.invalidateQueries({ queryKey: ["bootstrap"] });
      notify(existing ? "Saved." : `${name} can now log in.`);
      onClose();
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  return (
    <Dialog
      open
      title={existing ? `Edit ${existing.name}` : "Add a person"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={name.trim().length < 2 || !pinOk} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Role" hint="Owners see cost and profit, cancel bills, change prices and settings.">
          <Segmented label="Role" value={role} onChange={setRole} options={[{ value: "staff", label: "Staff" }, { value: "owner", label: "Owner" }]} />
        </Field>
        <Field label={existing ? "New PIN (leave empty to keep)" : "PIN"} hint={`${shortest} to 8 digits.`}>
          <input
            className="input"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          />
        </Field>
        {existing ? (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Can log in
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}

function PeopleTab() {
  const { me } = useSession();
  const notify = useToast();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<Person[]>("/api/users") });
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const changePin = useMutation({
    mutationFn: () => api.post("/api/auth/pin", { current_pin: current, new_pin: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      notify("Your PIN is changed.");
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  return (
    <section className="stack">
      <div className="spread">
        <h2>People who can log in</h2>
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} aria-hidden /> Add a person
        </Button>
      </div>
      {users.isPending ? <Loading /> : null}
      {users.data ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id} className="clickable" tabIndex={0} onClick={() => setEditing(u)} onKeyDown={(e) => e.key === "Enter" && setEditing(u)}>
                  <td>
                    {u.name}
                    {u.id === me.id ? <span className="muted small"> (you)</span> : null}
                  </td>
                  <td>{u.role === "owner" ? <Badge tone="gold">Owner</Badge> : <Badge>Staff</Badge>}</td>
                  <td>{!u.is_active ? <Badge tone="bad">Turned off</Badge> : u.locked ? <Badge tone="warn">Locked for a few minutes</Badge> : <Badge tone="good">Active</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="panel stack" style={{ maxWidth: 520 }}>
        <h3>
          <KeyRound size={16} aria-hidden /> Change my PIN
        </h3>
        <div className="form-grid">
          <Field label="Current PIN">
            <input className="input" type="password" inputMode="numeric" value={current} onChange={(e) => setCurrent(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="New PIN">
            <input className="input" type="password" inputMode="numeric" value={next} onChange={(e) => setNext(e.target.value.replace(/\D/g, "").slice(0, 8))} />
          </Field>
        </div>
        <Button onClick={() => changePin.mutate()} disabled={!current || next.length < 4} loading={changePin.isPending}>
          Change PIN
        </Button>
      </div>
      {editing ? <PersonDialog person={editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function NameList<T extends { id: number; name: string; is_active: boolean }>({
  title,
  items,
  url,
  queryKey,
  extra,
  newBody,
  hint,
}: {
  title: string;
  items: T[] | undefined;
  url: string;
  queryKey: string;
  extra?: (item: T) => ReactNode;
  newBody?: Record<string, string>;
  hint?: string;
}) {
  const client = useQueryClient();
  const notify = useToast();
  const [name, setName] = useState("");
  const refresh = () => {
    void client.invalidateQueries({ queryKey: [queryKey] });
    void client.invalidateQueries({ queryKey: ["bootstrap"] });
  };
  const add = useMutation({
    mutationFn: () => api.post(url, { name, ...newBody }),
    onSuccess: () => {
      setName("");
      refresh();
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patch(`${url}/${id}`, body),
    onSuccess: refresh,
    onError: (error) => notify(errorText(error), "bad"),
  });
  return (
    <section className="stack">
      <h2>{title}</h2>
      {hint ? <p className="muted small">{hint}</p> : null}
      <ul className="list">
        {(items ?? []).map((item) => (
          <li key={item.id}>
            <input
              className="input"
              style={{ maxWidth: 260 }}
              defaultValue={item.name}
              aria-label={`Name of ${item.name}`}
              onBlur={(e) => e.target.value.trim() && e.target.value !== item.name && update.mutate({ id: item.id, body: { name: e.target.value } })}
            />
            <span className="grow">{extra?.(item)}</span>
            <label className="check">
              <input type="checkbox" checked={item.is_active} onChange={(e) => update.mutate({ id: item.id, body: { is_active: e.target.checked } })} />
              In use
            </label>
          </li>
        ))}
      </ul>
      <div className="row">
        <input className="input" style={{ maxWidth: 260 }} placeholder="New name" value={name} onChange={(e) => setName(e.target.value)} />
        <Button onClick={() => add.mutate()} disabled={name.trim().length < 2} loading={add.isPending}>
          <Plus size={16} aria-hidden /> Add
        </Button>
      </div>
    </section>
  );
}

function PlacesTab() {
  const counters = useQuery({ queryKey: ["counters"], queryFn: () => api.get<Counter[]>("/api/counters") });
  const locations = useLocations();
  return (
    <div className="split">
      <NameList
        title="Billing counters"
        items={counters.data}
        url="/api/counters"
        queryKey="counters"
        hint="Each laptop picks its counter once. Bills show which counter made them."
      />
      <NameList<Location>
        title="Stock places"
        items={locations.data}
        url="/api/locations"
        queryKey="locations"
        newBody={{ kind: "godown" }}
        extra={(loc) => (loc.is_sale_location ? <Badge tone="gold">Bills take stock from here</Badge> : <Badge>{loc.kind === "godown" ? "Godown" : "Shop"}</Badge>)}
      />
    </div>
  );
}

function BackupTab() {
  const form = useSettingsForm();
  const client = useQueryClient();
  const notify = useToast();
  const info = useQuery({ queryKey: ["backups"], queryFn: () => api.get<BackupInfo>("/api/backups") });
  const backupNow = useMutation({
    mutationFn: () => api.post<BackupInfo>("/api/backups"),
    onSuccess: (data) => {
      client.setQueryData(["backups"], data);
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      if (data.status.drive_error) notify(`Saved on this PC. Google Drive copy failed: ${data.status.drive_error}`, "bad");
      else notify(data.status.drive_configured ? "Backed up to this PC and Google Drive." : "Backed up to this PC.");
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  const status = info.data?.status;
  return (
    <section className="stack">
      <div className="split">
        <div className="stack">
          <h2>Google Drive folder</h2>
          <p className="muted small">
            Install Google Drive for Desktop on the billing laptop and sign in with the shop's Google account. Then paste the path of a
            folder inside it here, for example <code>G:\My Drive\Sri Vinayaga Billing</code>. Each backup is copied into that folder, so it
            is safe even if the laptop is lost.
          </p>
          <Text form={form} name="backup_folder" label="Folder path" />
          <SaveBar form={form} />
        </div>
        <div className="stack">
          <h2>Status</h2>
          {info.isPending ? <Loading /> : null}
          {status ? (
            <dl className="kv">
              <dt>Last Hourly backup</dt>
              <dd>{status.last_hourly_at ? fmtDateTime(status.last_hourly_at) : "Not yet"}</dd>
              <dt>Last Day backup</dt>
              <dd>{status.last_day_at ? fmtDateTime(status.last_day_at) : "Not yet"}</dd>
              <dt>Last copy in Google Drive</dt>
              <dd>{status.last_drive_at ? fmtDateTime(status.last_drive_at) : "Never"}</dd>
            </dl>
          ) : null}
          {status?.last_local_at && !isToday(status.last_local_at) ? <Notice tone="warn">No backup today yet.</Notice> : null}
          {status?.drive_error ? <Notice tone="bad">Google Drive: {status.drive_error}</Notice> : null}
          {status?.excel_error ? (
            <Notice tone="warn">The last Excel copy could not be made ({status.excel_error}). The database backup is safe.</Notice>
          ) : null}
          <Button variant="primary" onClick={() => backupNow.mutate()} loading={backupNow.isPending}>
            <HardDrive size={16} aria-hidden /> Back up now
          </Button>
          <p className="caption">
            Every backup is two files with the same name: an Excel file you can open and read, and a database file used to restore. The
            name says which kind it is. <strong>Hourly_2026-10-25_14-00</strong> is made every hour from 7 AM to 10 PM and by Back up now,
            and kept for 2 days. <strong>Day_2026-10-25</strong> is the day's backup, made when the day is closed and again at 11 PM, and
            kept all season. Copies on this PC are kept in {info.data?.local_folder}.
          </p>
        </div>
      </div>
      <h2 style={{ marginTop: "var(--space-4)" }}>Restore</h2>
      <Notice tone="warn">
        Restoring replaces all current data on this PC with a backup. Close the billing server window first, then double-click{" "}
        <strong>scripts\restore_backup.bat</strong> and choose a backup from the list. It uses the database file; the Excel file is only for
        reading. The current data is saved first, so nothing is lost.
      </Notice>
      {info.data?.backups.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Backup taken</th>
                <th>Type</th>
                <th>Excel file (to open)</th>
                <th>Database file (to restore)</th>
              </tr>
            </thead>
            <tbody>
              {info.data.backups.slice(0, 15).map((b) => (
                <tr key={b.file}>
                  <td>{b.taken_at ? fmtDateTime(b.taken_at) : "—"}</td>
                  <td>{b.kind === "day" ? <Badge tone="gold">Day</Badge> : <Badge>{KIND_LABEL[b.kind]}</Badge>}</td>
                  <td>
                    {b.excel ?? <span className="muted">Not made</span>}
                    {b.excel ? <span className="muted small"> · {kb(b.excel_size)}</span> : null}
                  </td>
                  <td>
                    {b.file}
                    <span className="muted small"> · {kb(b.size)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : info.data ? (
        <Empty title="No backups yet" />
      ) : null}
    </section>
  );
}

function WhatsAppTab() {
  const form = useSettingsForm();
  if (!form.settings.data) return <Loading />;
  return (
    <section className="stack" style={{ maxWidth: 640 }}>
      <Text
        form={form}
        name="owner_whatsapp"
        label="Owner's WhatsApp number"
        hint="Day closing has a button that opens WhatsApp with the day's summary for this number. Press Send there."
      />
      <SaveBar form={form} />
    </section>
  );
}

function ActivityTab() {
  const log = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.get<{ id: number; at: string; user: string; action: string; summary: string }[]>("/api/audit"),
  });
  if (log.isPending) return <Loading />;
  if (log.isError) return <Notice tone="bad">{errorText(log.error)}</Notice>;
  return log.data.length ? (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          {log.data.map((row) => (
            <tr key={row.id}>
              <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(row.at)}</td>
              <td>{row.user || "—"}</td>
              <td>{row.summary || row.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="Nothing recorded yet" />
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("shop");
  return (
    <div className="page">
      <PageHead title="Settings" subtitle="Only owners can open this page." />
      <Tabs
        tabs={[
          { value: "shop", label: "Shop details" },
          { value: "bills", label: "Bills & GST" },
          { value: "people", label: "People & PINs" },
          { value: "places", label: "Counters & places" },
          { value: "backup", label: "Backup" },
          { value: "whatsapp", label: "WhatsApp" },
          { value: "activity", label: "Activity log" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "shop" ? <ShopTab /> : null}
      {tab === "bills" ? <BillsTab /> : null}
      {tab === "people" ? <PeopleTab /> : null}
      {tab === "places" ? <PlacesTab /> : null}
      {tab === "backup" ? <BackupTab /> : null}
      {tab === "whatsapp" ? <WhatsAppTab /> : null}
      {tab === "activity" ? <ActivityTab /> : null}
    </div>
  );
}

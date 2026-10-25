import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, UserPlus } from "lucide-react";
import { api, errorText, query } from "../lib/api";
import type { Customer, Paged } from "../lib/types";
import { Badge, Button, Dialog, Empty, Field, Loading, Notice, PageHead, Segmented, useToast } from "../components/ui";

const KINDS = [
  { value: "walk_in", label: "Walk-in" },
  { value: "regular", label: "Regular" },
  { value: "dealer", label: "Dealer" },
] as const;

function CustomerDialog({ customer, onClose }: { customer: Customer | "new"; onClose: () => void }) {
  const client = useQueryClient();
  const notify = useToast();
  const existing = customer === "new" ? null : customer;
  const [name, setName] = useState(existing?.name ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? "");
  const [kind, setKind] = useState<Customer["kind"]>(existing?.kind ?? "regular");
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.patch<Customer>(`/api/customers/${existing.id}`, { name, phone, kind })
        : api.post<Customer>("/api/customers", { name, phone, kind }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["customers"] });
      notify("Customer saved.");
      onClose();
    },
    onError: (error) => notify(errorText(error), "bad"),
  });
  return (
    <Dialog
      open
      title={existing ? "Edit customer" : "Add customer"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim() && !phone.trim()} onClick={() => save.mutate()}>
            Save customer
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Phone" hint="10 digits. Used to find the customer while billing.">
          <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Type">
          <Segmented label="Customer type" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        </Field>
      </div>
    </Dialog>
  );
}

export default function CustomersPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [limit, setLimit] = useState(50);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const list = useQuery({
    queryKey: ["customers", q, kind, limit],
    queryFn: () => api.get<Paged<Customer>>(`/api/customers${query({ q, kind, limit })}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="page">
      <PageHead
        title="Customers"
        subtitle="Name and phone only. Customers are also saved automatically when a phone number is typed on a bill."
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            <UserPlus size={16} aria-hidden /> Add customer
          </Button>
        }
      />
      <div className="toolbar">
        <div className="search" style={{ flex: "1 1 260px" }}>
          <Search size={16} aria-hidden />
          <input className="input" placeholder="Name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Segmented
          label="Customer type"
          value={kind}
          onChange={setKind}
          options={[{ value: "", label: "All" }, ...KINDS.map((k) => ({ value: k.value as string, label: k.label }))]}
        />
      </div>
      {list.isPending ? <Loading /> : null}
      {list.isError ? <Notice tone="bad">{errorText(list.error)}</Notice> : null}
      {list.data ? (
        list.data.results.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {list.data.results.map((c) => (
                  <tr key={c.id} className="clickable" tabIndex={0} onClick={() => setEditing(c)} onKeyDown={(e) => e.key === "Enter" && setEditing(c)}>
                    <td>{c.name || <span className="muted">No name</span>}</td>
                    <td className="num" style={{ textAlign: "left" }}>
                      {c.phone || "—"}
                    </td>
                    <td>
                      <Badge tone={c.kind === "dealer" ? "gold" : "neutral"}>{KINDS.find((k) => k.value === c.kind)?.label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No customers found" />
        )
      ) : null}
      {list.data && list.data.results.length < list.data.count ? (
        <div className="row" style={{ justifyContent: "center", marginTop: "var(--space-4)" }}>
          <Button onClick={() => setLimit((n) => n + 50)} loading={list.isFetching}>
            Show more
          </Button>
        </div>
      ) : null}
      {editing ? <CustomerDialog customer={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

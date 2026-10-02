import { useState, type FormEvent } from "react";
import { api } from "../api";
import { formatDate, slugify } from "../../shared/format";
import { errorMessage } from "../../shared/http";
import { useAsync } from "../../shared/hooks";
import { Alert, Badge, Button, Card, Empty, Field, Modal, PageHeader, Spinner } from "../../shared/ui";
import type { Consultant } from "../types";

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["Asia/Kolkata", "UTC"];
  }
}

export const paymentsBadge = (c: Consultant) =>
  !c.paymentsEnabled ? <Badge>Off</Badge> : <Badge tone={c.razorpayMode === "live" ? "good" : "warn"}>{c.razorpayMode === "live" ? "Live" : "Test mode"}</Badge>;

/** A strong random password the admin can hand over; the consultant can change it in their Settings. */
function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 54]).join("");
}

function NewConsultant({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Consultant, password: string) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [policy, setPolicy] = useState<"staff_approval" | "instant">("staff_approval");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(generatePassword);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { consultant } = await api.post<{ consultant: Consultant }>("/v1/admin/tenants", { name, slug: slug.replace(/^-+|-+$/g, ""), timezone, confirmationPolicy: policy, owner: { email, password } });
      onCreated(consultant, password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="New consultant" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Name"><input value={name} onChange={(e) => { setName(e.target.value); if (!slugEdited) setSlug(slugify(e.target.value)); }} required minLength={2} placeholder="Sunrise Dental Clinic" /></Field>
          <Field label="Slug" hint="Used in the chat widget and URLs. Can't be changed later."><input value={slug} onChange={(e) => { setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setSlugEdited(true); }} required minLength={3} pattern="[a-z0-9]+(-[a-z0-9]+)*" /></Field>
        </div>
        <div className="form-row">
          <Field label="Timezone"><input list="zones" value={timezone} onChange={(e) => setTimezone(e.target.value)} required /><datalist id="zones">{zones().map((z) => <option key={z} value={z} />)}</datalist></Field>
          <Field label="Booking flow"><select value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)}><option value="staff_approval">Doctor approval</option><option value="instant">Direct booking</option></select></Field>
        </div>
        <h3>First login for the consultant</h3>
        <div className="form-row">
          <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password" hint="Generated for you. Share it securely; they can change it in Settings.">
            <div className="copy-box"><input value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} spellCheck={false} /><Button small variant="secondary" onClick={() => setPassword(generatePassword())}>New</Button></div>
          </Field>
        </div>
        <Alert>{error}</Alert>
        <div className="form-foot"><Button type="submit" disabled={busy}>Create consultant</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}

export function ConsultantsPage({ open }: { open: (slug: string) => void }) {
  const list = useAsync(async () => (await api.get<{ tenants: Consultant[] }>("/v1/admin/tenants")).tenants);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ c: Consultant; password: string } | null>(null);

  return (
    <>
      <PageHeader title="Consultants" subtitle="Clinics and other appointment-based places on the platform." actions={<Button onClick={() => setCreating(true)}>New consultant</Button>} />
      <Alert>{list.error}</Alert>
      <Card>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty>No consultants yet.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Slug</th><th>Flow</th><th>Payments</th><th className="right">Appointments</th><th className="right">Users</th><th>Created</th></tr></thead>
              <tbody>
                {list.data.map((c) => (
                  <tr key={c.slug} className="clickable" onClick={() => open(c.slug)}>
                    <td><a href={`#/consultants/${c.slug}`} onClick={(e) => e.stopPropagation()}><strong>{c.name}</strong></a><br /><span className="muted small">{c.timezone}</span></td>
                    <td className="mono">{c.slug}</td>
                    <td>{c.confirmationPolicy === "instant" ? "Direct" : "Doctor approval"}</td>
                    <td>{paymentsBadge(c)}</td>
                    <td className="right">{c.counts.appointments}</td>
                    <td className="right">{c.counts.users}</td>
                    <td>{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewConsultant onClose={() => setCreating(false)} onCreated={(c, password) => { setCreating(false); setCreated({ c, password }); void list.reload(); }} />}
      {created && (
        <Modal title="Consultant created" onClose={() => setCreated(null)}>
          <Alert kind="success">{created.c.name} is ready.</Alert>
          <p>Give them this login for <code>/consultant/</code>. The password won't be shown again.</p>
          <div className="copy-box"><code>{created.password}</code></div>
          <p className="muted small">Next: open the consultant to connect Razorpay payments, or let them add their services and hours.</p>
          <div className="form-foot"><Button onClick={() => { const slug = created.c.slug; setCreated(null); open(slug); }}>Open consultant</Button><Button variant="ghost" onClick={() => setCreated(null)}>Done</Button></div>
        </Modal>
      )}
    </>
  );
}

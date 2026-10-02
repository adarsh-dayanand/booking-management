import { useState, type FormEvent } from "react";
import { api } from "../api";
import { formatDate } from "../../shared/format";
import { errorMessage } from "../../shared/http";
import { useAsync, useCopy } from "../../shared/hooks";
import { Alert, Button, Card, Empty, Field, Modal, PageHeader, Spinner, Tabs } from "../../shared/ui";
import type { Consultant, Login } from "../types";
import { paymentsBadge, whatsappBadge } from "./Consultants";

type Msg = { ok: boolean; text: string } | null;

function Profile({ c, onSaved }: { c: Consultant; onSaved: () => void }) {
  const [name, setName] = useState(c.name);
  const [timezone, setTimezone] = useState(c.timezone);
  const [phoneId, setPhoneId] = useState(c.whatsappPhoneNumberId ?? "");
  const own = c.whatsapp.mode === "own";
  const [msg, setMsg] = useState<Msg>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api.put(`/v1/admin/tenants/${c.slug}`, { name, timezone, ...(own ? {} : { whatsappPhoneNumberId: phoneId.trim() || null }) });
      setMsg({ ok: true, text: "Saved." });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  }
  return (
    <Card title="Profile">
      <form onSubmit={save}>
        <div className="form-row">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
          <Field label="Slug"><input value={c.slug} disabled /></Field>
        </div>
        <div className="form-row">
          <Field label="Timezone"><input value={timezone} onChange={(e) => setTimezone(e.target.value)} required /></Field>
          <Field
            label="WhatsApp phone number id"
            hint={own ? "The consultant connected their own number, so this can't be changed here. They (or you) must disconnect it first." : "Only for a number the platform owns (e.g. Meta's test number). Consultants normally connect their own number from their WhatsApp page."}
          >
            <input value={phoneId} onChange={(e) => setPhoneId(e.target.value)} disabled={own} />
          </Field>
        </div>
        <p className="muted small" style={{ marginBottom: 8 }}>
          WhatsApp: {whatsappBadge(c)} {c.whatsapp.displayPhone && <>{c.whatsapp.displayPhone} · {c.whatsapp.verifiedName}</>}
        </p>
        <p className="muted small">Chat widget snippet: <code>{`<script src="/widget.js" data-tenant="${c.slug}" defer></script>`}</code></p>
        <Alert kind={msg?.ok ? "success" : "error"}>{msg?.text}</Alert>
        <Button type="submit">Save profile</Button>
      </form>
    </Card>
  );
}

/** Razorpay setup. Credentials are checked against Razorpay before they are stored, and the secrets are never shown again. */
function PaymentsTab({ c, onSaved }: { c: Consultant; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(c.paymentsEnabled);
  const [keyId, setKeyId] = useState(c.razorpayKeyId ?? "");
  const [secret, setSecret] = useState("");
  const [webhook, setWebhook] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    // Blank secrets mean "keep what is stored", so toggling payments never requires re-entering them.
    const body: Record<string, unknown> = { enabled };
    if (keyId.trim() && keyId.trim() !== c.razorpayKeyId) body.razorpayKeyId = keyId.trim();
    if (secret) body.razorpayKeySecret = secret;
    if (webhook) body.razorpayWebhookSecret = webhook;
    try {
      await api.put(`/v1/admin/tenants/${c.slug}/payments`, body);
      setSecret("");
      setWebhook("");
      setMsg({ ok: true, text: enabled ? "Saved. Payments are enabled for this consultant." : "Saved. Payments are disabled." });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title="Razorpay payments" actions={paymentsBadge(c)}>
        <p className="muted">Payments stay off until you enable them here. Once on, the consultant sets their fees and chooses whether to collect them.</p>
        <form onSubmit={save}>
          <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <strong>Enable payments for {c.name}</strong></label>
          <Field label="Razorpay key id" hint="Starts with rzp_test_ (test mode) or rzp_live_ (live)."><input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="rzp_test_xxxxxxxx" spellCheck={false} /></Field>
          <div className="form-row">
            <Field label="Key secret" hint={c.keySecretConfigured ? "Stored. Leave blank to keep it." : "Required to enable."}><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={c.keySecretConfigured ? "•••••••• stored" : ""} autoComplete="off" /></Field>
            <Field label="Webhook secret" hint={c.webhookSecretConfigured ? "Stored. Leave blank to keep it." : "The secret you set on the webhook in Razorpay."}><input type="password" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder={c.webhookSecretConfigured ? "•••••••• stored" : ""} autoComplete="off" /></Field>
          </div>
          <Alert kind={msg?.ok ? "success" : "error"}>{msg?.text}</Alert>
          <Button type="submit" disabled={busy}>Save payments setup</Button>
        </form>
      </Card>
      <Card title="Register this webhook in Razorpay">
        <ol className="muted" style={{ margin: "0 0 12px", paddingLeft: 18 }}>
          <li>Razorpay dashboard → Settings → Webhooks → Add new webhook.</li>
          <li>Paste the URL below and use the same webhook secret you entered above.</li>
          <li>Tick the <code>payment_link.paid</code> event.</li>
        </ol>
        <div className="copy-box"><code>{c.webhookUrl}</code><Button small variant="secondary" onClick={() => copy(c.webhookUrl)}>{copied ? "Copied" : "Copy"}</Button></div>
        <p className="muted small">Without the webhook, payments are still confirmed when the user returns to the chat, but a webhook makes it instant. On a local server Razorpay can't reach <code>localhost</code>; use a tunnel.</p>
      </Card>
    </>
  );
}

function LoginsTab({ c, onChanged }: { c: Consultant; onChanged: () => void }) {
  const list = useAsync(async () => (await api.get<{ users: Login[] }>(`/v1/admin/tenants/${c.slug}/users`)).users, [c.slug]);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<Login | null>(null);
  const [error, setError] = useState("");

  async function remove(l: Login) {
    if (!window.confirm(`Remove the login ${l.email}? They will no longer be able to sign in.`)) return;
    try {
      setError("");
      await api.del(`/v1/admin/tenants/${c.slug}/users/${l.id}`);
      await list.reload();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card title="Consultant logins" actions={<Button small onClick={() => setAdding(true)}>Add login</Button>}>
      <Alert>{error || list.error}</Alert>
      {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty>No logins.</Empty> : (
        <ul className="list">
          {list.data.map((l) => (
            <li key={l.id}>
              <span><strong>{l.email}</strong> <span className="muted small">added {formatDate(l.createdAt)}</span></span>
              <span className="row-actions"><Button small variant="secondary" onClick={() => setResetting(l)}>Reset password</Button><Button small variant="danger" onClick={() => remove(l)}>Remove</Button></span>
            </li>
          ))}
        </ul>
      )}
      {adding && <LoginForm title="Add a login" slug={c.slug} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void list.reload(); onChanged(); }} />}
      {resetting && <LoginForm title={`Reset password · ${resetting.email}`} slug={c.slug} login={resetting} onClose={() => setResetting(null)} onDone={() => setResetting(null)} />}
    </Card>
  );
}

function LoginForm({ title, slug, login, onClose, onDone }: { title: string; slug: string; login?: Login; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (login) await api.post(`/v1/admin/tenants/${slug}/users/${login.id}/password`, { password });
      else await api.post(`/v1/admin/tenants/${slug}/users`, { email, password });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {!login && <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>}
        <Field label={login ? "New password" : "Password"} hint="At least 8 characters."><input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="off" spellCheck={false} /></Field>
        <Alert>{error}</Alert>
        <div className="form-foot"><Button type="submit">{login ? "Set password" : "Add login"}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}

export function ConsultantDetail({ slug, back }: { slug: string; back: () => void }) {
  const detail = useAsync(async () => (await api.get<{ consultant: Consultant }>(`/v1/admin/tenants/${slug}`)).consultant, [slug]);
  const [tab, setTab] = useState<"profile" | "payments" | "logins">("payments");
  const c = detail.data;
  return (
    <>
      <p><a href="#/consultants" onClick={(e) => { e.preventDefault(); back(); }}>← All consultants</a></p>
      <Alert>{detail.error}</Alert>
      {detail.loading && !c && <Spinner />}
      {c && (
        <>
          <PageHeader title={c.name} subtitle={<><span className="mono">{c.slug}</span> · {c.timezone} · {c.counts.appointments} appointments · {c.counts.users} users</>} actions={paymentsBadge(c)} />
          <Tabs tabs={[{ id: "payments", label: "Payments" }, { id: "profile", label: "Profile" }, { id: "logins", label: `Logins (${c.counts.logins})` }]} active={tab} onChange={setTab} />
          {tab === "payments" && <PaymentsTab c={c} onSaved={() => void detail.reload()} />}
          {tab === "profile" && <Profile c={c} onSaved={() => void detail.reload()} />}
          {tab === "logins" && <LoginsTab c={c} onChanged={() => void detail.reload()} />}
        </>
      )}
    </>
  );
}

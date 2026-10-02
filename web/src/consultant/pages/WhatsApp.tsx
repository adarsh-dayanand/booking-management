import { useState } from "react";
import { api } from "../api";
import { formatDate } from "../../shared/format";
import { errorMessage } from "../../shared/http";
import { useAsync } from "../../shared/hooks";
import { Alert, Badge, Button, Card, PageHeader, Spinner } from "../../shared/ui";
import { runEmbeddedSignup } from "../facebook";
import type { WhatsAppConnection, WhatsAppInfo } from "../types";

const templateTone = (status: string | null) => (status === "APPROVED" ? "good" : status === "REJECTED" || status === "DISABLED" ? "bad" : "warn");

function Connected({ c, onRepair, onDisconnect, busy }: { c: WhatsAppConnection; onRepair: () => void; onDisconnect: () => void; busy: boolean }) {
  return (
    <Card title="Your WhatsApp number" actions={<Badge tone="good">Connected</Badge>}>
      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat"><div className="stat-label">Users see</div><div className="stat-value" style={{ fontSize: "1.3rem" }}>{c.displayPhone ?? "—"}</div><div className="stat-hint">{c.verifiedName ?? "Name pending approval"}</div></div>
        <div className="stat"><div className="stat-label">Message template</div><div className="stat-value" style={{ fontSize: "1.3rem" }}>{c.template?.name ?? "—"}</div><div className="stat-hint">{c.template ? <Badge tone={templateTone(c.template.status)}>{(c.template.status ?? "unknown").toLowerCase()}</Badge> : "Not created"}</div></div>
        {c.quality && <div className="stat"><div className="stat-label">Number quality</div><div className="stat-value" style={{ fontSize: "1.3rem" }}>{c.quality.charAt(0) + c.quality.slice(1).toLowerCase()}</div></div>}
      </div>
      {c.template?.status && c.template.status !== "APPROVED" && (
        <Alert kind="info">Reminders and approval requests sent more than 24 hours after a user last wrote need the template to be <strong>approved</strong> by Meta (usually minutes to a day). Replies to people who just messaged you work already.</Alert>
      )}
      <p className="muted small">Connected {c.connectedAt ? formatDate(c.connectedAt) : ""}. Users who message this number are answered by the booking assistant.</p>
      <div className="form-foot">
        <Button variant="secondary" onClick={onRepair} disabled={busy}>Re-run setup</Button>
        <Button variant="danger" onClick={onDisconnect} disabled={busy}>Disconnect</Button>
      </div>
    </Card>
  );
}

export function WhatsAppPage() {
  const info = useAsync(() => api.get<WhatsAppInfo>("/v1/consultant/whatsapp"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  const data = info.data;
  const c = data?.connection;

  async function connect() {
    if (!data?.signup.available || !data.signup.appId || !data.signup.configId) return;
    setError("");
    setWarnings([]);
    setDone(false);
    setBusy(true);
    try {
      const result = await runEmbeddedSignup({ appId: data.signup.appId, configId: data.signup.configId, graphVersion: data.signup.graphVersion });
      const r = await api.post<{ warnings: string[] }>("/v1/consultant/whatsapp/connect", result);
      setWarnings(r.warnings);
      setDone(true);
      await info.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function repair() {
    setBusy(true);
    setError("");
    try {
      const r = await api.post<{ warnings: string[] }>("/v1/consultant/whatsapp/repair");
      setWarnings(r.warnings);
      setDone(r.warnings.length === 0);
      await info.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect this WhatsApp number? Users will no longer be able to book through it until you connect again.")) return;
    setBusy(true);
    setError("");
    try {
      await api.del("/v1/consultant/whatsapp");
      setWarnings([]);
      setDone(false);
      await info.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="WhatsApp" subtitle="Let users book by chatting with your clinic's own WhatsApp number." />
      <Alert>{error || info.error}</Alert>
      {info.loading && !data && <Spinner />}
      {done && warnings.length === 0 && <Alert kind="success">WhatsApp is connected. Message your number from a phone to try it.</Alert>}
      {warnings.map((w) => <Alert key={w} kind="warning">{w}</Alert>)}
      {warnings.length > 0 && c?.mode === "own" && <Button variant="secondary" onClick={repair} disabled={busy}>Retry setup</Button>}

      {c?.mode === "own" && <Connected c={c} onRepair={repair} onDisconnect={disconnect} busy={busy} />}

      {c?.mode === "platform" && (
        <Alert kind="info">
          This clinic uses a WhatsApp number set up by the platform ({c.displayPhone ?? c.phoneNumberId}). You can switch to your own number below.
        </Alert>
      )}

      {c && c.mode !== "own" && (
        <Card title={c.mode === "platform" ? "Use your own number instead" : "Connect your WhatsApp number"}>
          <p>Users will chat with <strong>your clinic's own number</strong>, and your clinic's name appears on the chat. You sign in with Facebook and choose or add the number; nothing to copy or paste.</p>
          <h3 style={{ marginTop: 16 }}>Before you start</h3>
          <ul className="muted" style={{ margin: "0 0 14px", paddingLeft: 18 }}>
            <li>Use a number that can receive an SMS or call to verify it. <strong>A number that is active on the regular WhatsApp or WhatsApp Business app will stop working there</strong> once it moves to this platform, so use a spare or new number, not your personal one.</li>
            <li>Have a Facebook account that manages your business (you can create the business account during sign-up).</li>
            <li>Your business name is reviewed by Meta. Larger sending limits and the green tick need Meta business verification.</li>
          </ul>
          {data && !data.signup.available && (
            <Alert kind="info">Connecting your own number isn't enabled on this platform yet. Ask your administrator to set up WhatsApp sign-up.</Alert>
          )}
          <Button onClick={connect} disabled={busy || !data?.signup.available}>{busy ? "Waiting for Meta…" : "Connect WhatsApp number"}</Button>
        </Card>
      )}

      <Card title="What users see">
        <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Your number and business name, as on any WhatsApp business chat.</li>
          <li>The booking assistant's replies, in the language they write in.</li>
          <li>Reminders, confirmations and doctor decisions on the same chat.</li>
        </ul>
      </Card>
    </>
  );
}

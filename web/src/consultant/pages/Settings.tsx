import { useState, type FormEvent } from "react";
import { api } from "../api";
import { errorMessage } from "../../shared/http";
import { useAsync } from "../../shared/hooks";
import { Alert, Button, Card, Field, PageHeader, Spinner } from "../../shared/ui";
import type { Settings } from "../types";

interface SettingsResponse { settings: Settings; warnings?: string[] }

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["Asia/Kolkata", "UTC"];
  }
}

const INTERVAL_PRESETS = [5, 10, 15, 20, 30, 45, 60];

function SettingsForm({ initial, onSaved }: { initial: Settings; onSaved: (s: Settings) => void }) {
  const [f, setF] = useState({
    name: initial.name, timezone: initial.timezone, policy: initial.confirmationPolicy, staffNumber: initial.staffWhatsappNumber ?? "",
    phoneId: initial.whatsappPhoneNumberId ?? "", reminder: String(initial.reminderHoursBefore), faq: initial.faqText ?? "",
    interval: String(initial.slotIntervalMinutes),
  });
  const [customInterval, setCustomInterval] = useState(() => !INTERVAL_PRESETS.includes(initial.slotIntervalMinutes));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api.put<SettingsResponse>("/v1/consultant/settings", {
        name: f.name, timezone: f.timezone, confirmationPolicy: f.policy,
        staffWhatsappNumber: f.staffNumber.trim() || null, whatsappPhoneNumberId: f.phoneId.trim() || null,
        reminderHoursBefore: Number(f.reminder), slotIntervalMinutes: Number(f.interval), faqText: f.faq.trim() || null,
      });
      setMsg({ ok: true, text: "Saved." });
      setWarnings(r.warnings ?? []);
      onSaved(r.settings);
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  }

  return (
    <form onSubmit={save}>
      <Card title="Booking flow">
        <label className="choice"><input type="radio" name="policy" checked={f.policy === "instant"} onChange={() => set("policy", "instant")} /><span><strong>Direct booking</strong><small>Only free calendar times are offered. A booking confirms immediately and blocks the calendar.</small></span></label>
        <label className="choice"><input type="radio" name="policy" checked={f.policy === "staff_approval"} onChange={() => set("policy", "staff_approval")} /><span><strong>Doctor approval</strong><small>A booking is a request until the doctor accepts it (Approve in this dashboard, or by WhatsApp).</small></span></label>
      </Card>
      <Card title="Clinic">
        <div className="form-row">
          <Field label="Name"><input value={f.name} onChange={(e) => set("name", e.target.value)} required minLength={2} /></Field>
          <Field label="Timezone" hint="Opening hours and fee bands use this."><input list="zones" value={f.timezone} onChange={(e) => set("timezone", e.target.value)} required /><datalist id="zones">{zones().map((z) => <option key={z} value={z} />)}</datalist></Field>
        </div>
        <Field label="Information the assistant may answer from" hint="Opening notes, address, parking, what to bring… The assistant won't go beyond this."><textarea value={f.faq} onChange={(e) => set("faq", e.target.value)} maxLength={4000} /></Field>
      </Card>
      <Card title="Scheduling">
        <div className="form-row">
          <Field label="Time slot interval" hint={`Start times are offered every ${f.interval || "…"} minutes — 5 gives 9:00, 9:05, 9:10…; 30 gives 9:00, 9:30… It is also the step in the reschedule time picker.`}>
            <select
              value={customInterval ? "custom" : f.interval}
              onChange={(e) => (e.target.value === "custom" ? setCustomInterval(true) : (setCustomInterval(false), set("interval", e.target.value)))}
            >
              {INTERVAL_PRESETS.map((m) => <option key={m} value={m}>{m === 5 ? "5 minutes (default)" : m === 60 ? "1 hour" : `${m} minutes`}</option>)}
              <option value="custom">Custom…</option>
            </select>
          </Field>
          {customInterval && (
            <Field label="Custom interval (minutes)" hint="Between 5 and 240.">
              <input type="number" min={5} max={240} step={1} value={f.interval} onChange={(e) => set("interval", e.target.value)} required />
            </Field>
          )}
        </div>
      </Card>
      <Card title="WhatsApp & reminders">
        <div className="form-row">
          <Field label="Doctor's WhatsApp number" hint="With country code. Approval requests and alerts go here."><input value={f.staffNumber} onChange={(e) => set("staffNumber", e.target.value)} placeholder="+91 98765 43210" /></Field>
          <Field label="WhatsApp phone number id" hint="From the Meta developer console. Links your WhatsApp number to this clinic."><input value={f.phoneId} onChange={(e) => set("phoneId", e.target.value)} /></Field>
          <Field label="Reminder (hours before)" hint="0 turns reminders off."><input type="number" min={0} max={168} value={f.reminder} onChange={(e) => set("reminder", e.target.value)} /></Field>
        </div>
      </Card>
      {warnings.map((w) => <Alert key={w} kind="warning">{w}</Alert>)}
      <Alert kind={msg?.ok ? "success" : "error"}>{msg?.text}</Alert>
      <Button type="submit">Save settings</Button>
    </form>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api.post("/v1/consultant/account/password", { currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setMsg({ ok: true, text: "Password changed." });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  }
  return (
    <Card title="Change your password">
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Current password"><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" /></Field>
          <Field label="New password" hint="At least 8 characters."><input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" /></Field>
        </div>
        <Alert kind={msg?.ok ? "success" : "error"}>{msg?.text}</Alert>
        <Button type="submit" variant="secondary">Change password</Button>
      </form>
    </Card>
  );
}

export function SettingsPage({ onSaved }: { onSaved: (s: Settings) => void }) {
  const s = useAsync(async () => (await api.get<SettingsResponse>("/v1/consultant/settings")).settings);
  return (
    <>
      <PageHeader title="Settings" />
      <Alert>{s.error}</Alert>
      {s.loading && !s.data && <Spinner />}
      {s.data && <SettingsForm initial={s.data} onSaved={onSaved} />}
      <PasswordCard />
    </>
  );
}

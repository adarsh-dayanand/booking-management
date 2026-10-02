import { useState, type FormEvent } from "react";
import { api } from "../api";
import { formatRupees } from "../../shared/format";
import { useClinic } from "../clinic";
import { errorMessage } from "../../shared/http";
import { useAsync } from "../../shared/hooks";
import { Alert, Badge, Button, Card, Empty, Field, PageHeader, Spinner } from "../../shared/ui";
import type { PaymentSettings, Pricing, Transaction } from "../types";

interface Form { collect: boolean; mode: "flat" | "variable"; flat: string; weekday: string; weekend: string; night: string; nightStart: string; nightEnd: string }
const EMPTY: Form = { collect: false, mode: "flat", flat: "", weekday: "", weekend: "", night: "", nightStart: "20:00", nightEnd: "06:00" };

export function fromSettings(s: PaymentSettings): Form {
  const p = s.pricing;
  const f: Form = { ...EMPTY, collect: s.collectPayments };
  if (!p) return f;
  f.mode = p.mode;
  if (p.mode === "flat") f.flat = String(p.hourlyRate);
  else Object.assign(f, { weekday: String(p.weekdayRate), weekend: String(p.weekendRate), night: String(p.nightRate), nightStart: p.nightStart, nightEnd: p.nightEnd });
  return f;
}

export function toPricing(f: Form): Pricing {
  return f.mode === "flat"
    ? { mode: "flat", hourlyRate: Number(f.flat) }
    : { mode: "variable", weekdayRate: Number(f.weekday), weekendRate: Number(f.weekend), nightRate: Number(f.night), nightStart: f.nightStart, nightEnd: f.nightEnd };
}

function FeesCard({ settings, onSaved }: { settings: PaymentSettings; onSaved: () => void }) {
  const [form, setForm] = useState<Form>(() => fromSettings(settings));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    try {
      await api.put("/v1/consultant/payments", { collectPayments: form.collect, pricing: toPricing(form) });
      setMessage({ ok: true, text: "Saved." });
      onSaved();
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    }
  }
  const rate = (label: string, key: "flat" | "weekday" | "weekend" | "night") => (
    <Field label={label}><input type="number" min="0" step="0.01" value={form[key]} onChange={(e) => set(key, e.target.value)} /></Field>
  );

  return (
    <Card title="Consultation fees">
      <form onSubmit={save}>
        <label className="check"><input type="checkbox" checked={form.collect} onChange={(e) => set("collect", e.target.checked)} /> <span><strong>Collect payment (Razorpay) before a booking is confirmed</strong><br /><span className="muted small">Users pay a link in the chat; the slot is held until they do.</span></span></label>
        <label className="choice"><input type="radio" name="fees-mode" checked={form.mode === "flat"} onChange={() => set("mode", "flat")} /><span>Same hourly fee at all times</span></label>
        <label className="choice"><input type="radio" name="fees-mode" checked={form.mode === "variable"} onChange={() => set("mode", "variable")} /><span>Different fees for weekdays, weekends and nights</span></label>
        <div className="form-row">
          {form.mode === "flat" ? rate("Fee per hour (₹)", "flat") : (
            <>
              {rate("Weekday (Mon–Fri) ₹/hr", "weekday")}
              {rate("Weekend (Sat–Sun) ₹/hr", "weekend")}
              {rate("Night ₹/hr", "night")}
              <Field label="Night starts"><input type="time" value={form.nightStart} onChange={(e) => set("nightStart", e.target.value)} /></Field>
              <Field label="Night ends"><input type="time" value={form.nightEnd} onChange={(e) => set("nightEnd", e.target.value)} /></Field>
            </>
          )}
        </div>
        <p className="muted small">Fees are per hour and prorated by the service's duration (a 30-minute visit at ₹1000/hr costs ₹500). The start time picks the rate; night overrides weekday and weekend.</p>
        <Alert kind={message?.ok ? "success" : "error"}>{message?.text}</Alert>
        <Button type="submit">Save fees</Button>
      </form>
    </Card>
  );
}

const payTone = (s: Transaction["status"]) => (s === "paid" ? "good" : s === "created" ? "info" : "neutral");

export function PaymentsPage() {
  const clinic = useClinic();
  const settings = useAsync(async () => (await api.get<{ payments: PaymentSettings }>("/v1/consultant/payments")).payments);
  const tx = useAsync(async () => (await api.get<{ transactions: Transaction[] }>("/v1/consultant/payments/transactions")).transactions);
  const s = settings.data;
  const paid = (tx.data ?? []).filter((t) => t.status === "paid");

  return (
    <>
      <PageHeader title="Payments" subtitle="Set your fees and see what users have paid." />
      <Alert>{settings.error}</Alert>
      {settings.loading && !s && <Spinner />}
      {s && !s.available && <Alert kind="info">{s.note}</Alert>}
      {s?.available && <FeesCard settings={s} onSaved={() => void settings.reload()} />}
      <Card title="Transactions" actions={paid.length > 0 ? <span className="muted small">{paid.length} paid · {formatRupees(paid.reduce((n, t) => n + t.amount_paise, 0))}</span> : undefined}>
        <Alert>{tx.error}</Alert>
        {tx.loading && !tx.data ? <Spinner /> : !tx.data?.length ? <Empty>No payments yet.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Created</th><th>User</th><th>Service</th><th>Appointment</th><th>Rate</th><th className="right">Amount</th><th>Status</th><th>Razorpay id</th></tr></thead>
              <tbody>
                {tx.data.map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap">{clinic.when(t.created_at)}</td>
                    <td>{t.patient_name ?? "—"}<br /><span className="muted small">{t.patient_phone}</span></td>
                    <td>{t.service_name}</td>
                    <td className="nowrap">{clinic.when(t.start_at)}</td>
                    <td>{t.band}</td>
                    <td className="right">{formatRupees(t.amount_paise)}</td>
                    <td><Badge tone={payTone(t.status)}>{t.status}</Badge></td>
                    <td className="mono">{t.razorpay_payment_id ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

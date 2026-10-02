import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import type { PaymentSettings, Pricing } from "../types";

interface Form {
  collect: boolean;
  mode: "flat" | "variable";
  flat: string;
  weekday: string;
  weekend: string;
  night: string;
  nightStart: string;
  nightEnd: string;
}

const EMPTY: Form = { collect: false, mode: "flat", flat: "", weekday: "", weekend: "", night: "", nightStart: "20:00", nightEnd: "06:00" };

function fromSettings(s: PaymentSettings): Form {
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

export function FeesCard() {
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    api
      .get<{ payments: PaymentSettings }>("/v1/consultant/payments")
      .then(({ payments }) => {
        setSettings(payments);
        setForm(fromSettings(payments));
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage("");
    try {
      await api.send("PUT", "/v1/consultant/payments", { collectPayments: form.collect, pricing: toPricing(form) });
      setMessage("Saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save");
    }
  }

  const rate = (label: string, key: "flat" | "weekday" | "weekend" | "night") => (
    <label>
      {label}
      <br />
      <input type="number" min="0" step="0.01" value={form[key]} onChange={(e) => set(key, e.target.value)} />
    </label>
  );

  return (
    <>
      <h2>Consultation fees</h2>
      <div className="card">
        {loadError && <div className="error" role="alert">{loadError}</div>}
        {settings && !settings.available && <div className="hint">{settings.note}</div>}
        {settings?.available && (
          <form onSubmit={save}>
            <label>
              <input type="checkbox" checked={form.collect} onChange={(e) => set("collect", e.target.checked)} /> Collect payment (Razorpay) before a booking is confirmed
            </label>
            <label>
              <input type="radio" name="fees-mode" checked={form.mode === "flat"} onChange={() => set("mode", "flat")} /> Same hourly fee at all times
            </label>
            <label>
              <input type="radio" name="fees-mode" checked={form.mode === "variable"} onChange={() => set("mode", "variable")} /> Different fees for weekdays, weekends and nights
            </label>
            <div className="row">
              {form.mode === "flat" ? (
                rate("Fee per hour (₹)", "flat")
              ) : (
                <>
                  {rate("Weekday (Mon–Fri) ₹/hr", "weekday")}
                  {rate("Weekend (Sat–Sun) ₹/hr", "weekend")}
                  {rate("Night ₹/hr", "night")}
                  <label>Night starts<br /><input type="time" value={form.nightStart} onChange={(e) => set("nightStart", e.target.value)} /></label>
                  <label>Night ends<br /><input type="time" value={form.nightEnd} onChange={(e) => set("nightEnd", e.target.value)} /></label>
                </>
              )}
            </div>
            <div className="hint">
              Fees are per hour and prorated by the service's duration (a 30-minute visit at ₹1000/hr costs ₹500). Night overrides weekday/weekend.
            </div>
            <p>
              <button type="submit">Save fees</button> <span className="hint">{message}</span>
            </p>
          </form>
        )}
      </div>
    </>
  );
}

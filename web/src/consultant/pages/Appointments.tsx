import { useMemo, useState } from "react";
import { api } from "../api";
import { downloadFile, formatRupees, humanize, toCsv } from "../../shared/format";
import { DateTimePicker } from "../../shared/DateTimePicker";
import { formatInZone, localStringIn, parseLocal, zonedToUtc } from "../../shared/zoned";
import { useClinic } from "../clinic";
import { errorMessage } from "../../shared/http";
import { useAsync } from "../../shared/hooks";
import { Alert, Badge, Button, Card, Empty, Field, Modal, PageHeader, Spinner } from "../../shared/ui";
import type { Appointment, AppointmentStatus } from "../types";

export function statusTone(s: AppointmentStatus): "good" | "warn" | "bad" | "info" | "neutral" {
  return s === "CONFIRMED" ? "good" : s === "PENDING_CONFIRMATION" ? "warn" : s === "AWAITING_PAYMENT" ? "info" : s === "CANCELLED" || s === "REJECTED" ? "bad" : "neutral";
}

const LIVE: AppointmentStatus[] = ["AWAITING_PAYMENT", "PENDING_CONFIRMATION", "CONFIRMED"];
const FILTERS: { id: string; label: string; test: (a: Appointment) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "upcoming", label: "Upcoming", test: (a) => LIVE.includes(a.status) && new Date(a.start_at) >= new Date() },
  { id: "needs-approval", label: "Needs approval", test: (a) => a.status === "PENDING_CONFIRMATION" },
  { id: "awaiting-payment", label: "Awaiting payment", test: (a) => a.status === "AWAITING_PAYMENT" },
  { id: "confirmed", label: "Confirmed", test: (a) => a.status === "CONFIRMED" },
  { id: "closed", label: "Cancelled / rejected", test: (a) => a.status === "CANCELLED" || a.status === "REJECTED" },
];

/** Reject / cancel: the reason is optional and is passed on to the user. */
function ReasonModal({ title, confirm, onClose, onDone, path }: { title: string; confirm: string; onClose: () => void; onDone: () => void; path: string }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api.post(path, { reason: reason.trim() || undefined });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <Field label="Reason (optional)" hint="Included in the message to the user."><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      <Alert>{error}</Alert>
      <div className="form-foot">
        <Button variant="danger" onClick={submit} disabled={busy}>{confirm}</Button>
        <Button variant="ghost" onClick={onClose}>Keep it</Button>
      </div>
    </Modal>
  );
}

interface SlotCheck {
  inPast: boolean;
  withinHours: boolean;
  hours: { start: string; end: string } | null;
  conflicts: { id: string; patientName: string | null; startAt: string; endAt: string }[];
}

/**
 * Move an appointment to any date and time. Times follow the consultant's slot interval but are not limited to working
 * hours — the check underneath only warns. An overlap with another booking can't be saved, so it blocks the button.
 */
function RescheduleModal({ appointment, onClose, onDone }: { appointment: Appointment; onClose: () => void; onDone: () => void }) {
  const clinic = useClinic();
  const tz = clinic.timezone;
  const [value, setValue] = useState(() => localStringIn(new Date(appointment.start_at), tz));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const startUtc = zonedToUtc(parseLocal(value), tz);
  const startIso = startUtc.toISOString();
  const unchanged = startUtc.getTime() === new Date(appointment.start_at).getTime();
  const check = useAsync(
    () => (unchanged ? Promise.resolve(null) : api.get<SlotCheck>(`/v1/consultant/slots/check?serviceId=${appointment.service_id}&resourceId=${appointment.resource_id}&startAt=${encodeURIComponent(startIso)}&excludeAppointmentId=${appointment.id}`)),
    [startIso]
  );
  const c = check.data;
  const blocked = unchanged || check.loading || Boolean(check.error) || !c || c.inPast || c.conflicts.length > 0;

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/v1/consultant/appointments/${appointment.id}/reschedule`, { startAt: startIso });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  let note: { kind: string; text: string };
  if (unchanged) note = { kind: "wait", text: "Pick a new date and time." };
  else if (check.loading || !c) note = { kind: "wait", text: check.error || "Checking availability…" };
  else if (c.inPast) note = { kind: "bad", text: "That time has already passed." };
  else if (c.conflicts.length) note = { kind: "bad", text: `Overlaps ${c.conflicts.map((x) => `${x.patientName ?? "another booking"} (${formatInZone(x.startAt, tz, { hour: "numeric", minute: "2-digit", hour12: true })})`).join(", ")}. Choose a different time.` };
  else if (!c.withinHours) note = { kind: "warn", text: c.hours ? `Outside ${appointment.resource_name}'s usual hours (${c.hours.start}–${c.hours.end}). You can still book it.` : `${appointment.resource_name} isn't normally working that day. You can still book it.` };
  else note = { kind: "ok", text: "Free — inside working hours." };

  return (
    <Modal title="Reschedule" onClose={onClose} wide>
      <p className="muted" style={{ marginBottom: 14 }}>
        {appointment.patient_name} · {appointment.service_name} with {appointment.resource_name}<br />
        Currently {formatInZone(appointment.start_at, tz)}
      </p>
      <DateTimePicker value={value} onChange={setValue} minDate={localStringIn(new Date(), tz).slice(0, 10)} stepMinutes={clinic.slotIntervalMinutes} />
      <div className={`avail avail-${note.kind}`} role="status">{note.text}</div>
      <Alert>{error}</Alert>
      <p className="muted small" style={{ marginTop: 12 }}>
        Times are in {tz}, every {clinic.slotIntervalMinutes} minutes (change this in Settings). The user is told about the new time.
      </p>
      <div className="form-foot">
        <Button onClick={confirm} disabled={blocked || busy}>{unchanged ? "Move appointment" : `Move to ${formatInZone(startUtc, tz, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })}`}</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

type Dialog = { kind: "reject" | "cancel" | "reschedule"; appointment: Appointment } | null;

export function AppointmentsPage({ filter, onFilter }: { filter?: string; onFilter: (id: string) => void }) {
  const clinic = useClinic();
  const list = useAsync(async () => (await api.get<{ appointments: Appointment[] }>("/v1/consultant/appointments")).appointments);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState("");
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list.data ?? [])
      .filter(active.test)
      .filter((a) => !q || [a.patient_name, a.patient_phone, a.service_name, a.resource_name].some((v) => v?.toLowerCase().includes(q)));
  }, [list.data, active, query]);

  async function act(a: Appointment, action: "approve" | "retry-sync") {
    try {
      setError("");
      await api.post(`/v1/consultant/appointments/${a.id}/${action}`);
      await list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const done = () => { setDialog(null); void list.reload(); };

  function exportCsv() {
    downloadFile(
      `appointments-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv([
        ["When", "User", "Phone", "Service", "Practitioner", "Channel", "Status", "Payment", "Amount (INR)"],
        ...rows.map((a) => [clinic.when(a.start_at), a.patient_name, a.patient_phone, a.service_name, a.resource_name, a.channel, a.status, a.payment_status, a.amount_paise == null ? "" : a.amount_paise / 100]),
      ])
    );
  }

  return (
    <>
      <PageHeader title="Appointments" actions={<Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</Button>} />
      <div className="toolbar">
        <div className="chips">
          {FILTERS.map((f) => <button key={f.id} className="chip" aria-pressed={f.id === active.id} onClick={() => onFilter(f.id)}>{f.label}</button>)}
        </div>
        <input type="search" placeholder="Search name, phone, service…" aria-label="Search appointments" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <Alert>{error || list.error}</Alert>
      <Card>
        {list.loading && !list.data ? <Spinner /> : rows.length === 0 ? <Empty>No appointments match.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>User</th><th>Service</th><th>Status</th><th>Payment</th><th>Calendar</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">{clinic.when(a.start_at)}</td>
                    <td>{a.patient_name ?? "—"}<br /><span className="muted small">{a.patient_phone} · {a.channel}</span></td>
                    <td>{a.service_name}<br /><span className="muted small">{a.resource_name}</span></td>
                    <td><Badge tone={statusTone(a.status)}>{humanize(a.status)}</Badge></td>
                    <td>{a.payment_status ? <><Badge tone={a.payment_status === "paid" ? "good" : "neutral"}>{a.payment_status}</Badge><br /><span className="muted small">{formatRupees(a.amount_paise ?? 0)}</span></> : "—"}</td>
                    <td>{a.calendar_sync_status === "failed" ? <Badge tone="bad">failed</Badge> : <span className="muted">{a.calendar_sync_status}</span>}</td>
                    <td>
                      <div className="row-actions">
                        {a.status === "PENDING_CONFIRMATION" && <><Button small onClick={() => act(a, "approve")}>Approve</Button><Button small variant="danger" onClick={() => setDialog({ kind: "reject", appointment: a })}>Reject</Button></>}
                        {(a.status === "PENDING_CONFIRMATION" || a.status === "CONFIRMED") && <Button small variant="secondary" onClick={() => setDialog({ kind: "reschedule", appointment: a })}>Reschedule</Button>}
                        {LIVE.includes(a.status) && <Button small variant="danger" onClick={() => setDialog({ kind: "cancel", appointment: a })}>Cancel</Button>}
                        {a.calendar_sync_status === "failed" && <Button small variant="secondary" onClick={() => act(a, "retry-sync")}>Retry sync</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {dialog?.kind === "reject" && <ReasonModal title="Reject this request" confirm="Reject request" path={`/v1/consultant/appointments/${dialog.appointment.id}/reject`} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "cancel" && <ReasonModal title="Cancel this appointment" confirm="Cancel appointment" path={`/v1/consultant/appointments/${dialog.appointment.id}/cancel`} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "reschedule" && <RescheduleModal appointment={dialog.appointment} onClose={() => setDialog(null)} onDone={done} />}
    </>
  );
}

import { useState, type FormEvent } from "react";
import { api } from "../api";
import { WEEKDAYS } from "../../shared/format";
import { errorMessage } from "../../shared/http";
import { useAsync, useCopy } from "../../shared/hooks";
import { Alert, Badge, Button, Card, Empty, Field, Modal, PageHeader, Spinner } from "../../shared/ui";
import type { Availability, Resource } from "../types";

interface DayRow { on: boolean; start: string; end: string }
const DEFAULT_DAY: DayRow = { on: false, start: "09:00", end: "17:00" };
// Monday first in the UI; the API uses 0 = Sunday.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Weekly opening hours (one window per day) plus holidays / special days. Saved as one atomic schedule. */
function HoursEditor({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const [days, setDays] = useState<Record<number, DayRow>>({});
  const [exceptions, setExceptions] = useState<Availability["exceptions"]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const loaded = useAsync(async () => {
    const a = await api.get<Availability>(`/v1/consultant/resources/${resource.id}/availability`);
    const next: Record<number, DayRow> = {};
    for (const d of ORDER) {
      const w = a.weekly.find((x) => x.weekday === d);
      next[d] = w ? { on: true, start: w.start, end: w.end } : { ...DEFAULT_DAY };
    }
    setDays(next);
    setExceptions(a.exceptions);
    return a;
  });

  const setDay = (d: number, patch: Partial<DayRow>) => setDays((all) => ({ ...all, [d]: { ...all[d], ...patch } }));
  const setException = (i: number, patch: Partial<Availability["exceptions"][number]>) => setExceptions((all) => all.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  async function save() {
    setError("");
    setSaved(false);
    setBusy(true);
    try {
      await api.put(`/v1/consultant/resources/${resource.id}/availability`, {
        weekly: ORDER.filter((d) => days[d].on).map((d) => ({ weekday: d, start: days[d].start, end: days[d].end })),
        exceptions: exceptions.map((e) => (e.closed ? { date: e.date, closed: true } : { date: e.date, closed: false, start: e.start ?? "09:00", end: e.end ?? "13:00" })),
      });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Working hours · ${resource.name}`} onClose={onClose} wide>
      <Alert>{loaded.error}</Alert>
      {loaded.loading && <Spinner />}
      {loaded.data && (
        <>
          <h3>Weekly hours</h3>
          {ORDER.map((d) => (
            <div className="hours-row" key={d}>
              <label className="check"><input type="checkbox" checked={days[d]?.on ?? false} onChange={(e) => setDay(d, { on: e.target.checked })} /> {WEEKDAYS[d]}</label>
              <input type="time" aria-label={`${WEEKDAYS[d]} opens`} value={days[d]?.start ?? ""} disabled={!days[d]?.on} onChange={(e) => setDay(d, { start: e.target.value })} />
              <input type="time" aria-label={`${WEEKDAYS[d]} closes`} value={days[d]?.end ?? ""} disabled={!days[d]?.on} onChange={(e) => setDay(d, { end: e.target.value })} />
            </div>
          ))}
          <p className="muted small">Unticked days are closed.</p>
          <h3>Holidays and special days</h3>
          {exceptions.length === 0 && <p className="muted small">None. Add a date to close for a holiday or to use different hours that day.</p>}
          {exceptions.map((e, i) => (
            <div className="form-row" key={i} style={{ alignItems: "flex-end" }}>
              <Field label="Date"><input type="date" value={e.date} onChange={(ev) => setException(i, { date: ev.target.value })} /></Field>
              <Field label="That day"><select value={e.closed ? "closed" : "open"} onChange={(ev) => setException(i, { closed: ev.target.value === "closed", start: e.start ?? "09:00", end: e.end ?? "13:00" })}><option value="closed">Closed</option><option value="open">Special hours</option></select></Field>
              {!e.closed && <><Field label="Opens"><input type="time" value={e.start ?? "09:00"} onChange={(ev) => setException(i, { start: ev.target.value })} /></Field><Field label="Closes"><input type="time" value={e.end ?? "13:00"} onChange={(ev) => setException(i, { end: ev.target.value })} /></Field></>}
              <Button small variant="ghost" onClick={() => setExceptions((all) => all.filter((_, j) => j !== i))} aria-label="Remove date">Remove</Button>
            </div>
          ))}
          <Button small variant="secondary" onClick={() => setExceptions((all) => [...all, { date: "", closed: true }])}>Add a date</Button>
          <Alert>{error}</Alert>
          <Alert kind="success">{saved ? "Saved. New bookings follow these hours." : ""}</Alert>
          <div className="form-foot"><Button onClick={save} disabled={busy}>Save hours</Button><Button variant="ghost" onClick={onClose}>Close</Button></div>
        </>
      )}
    </Modal>
  );
}

/** Doctors connect their own Google Calendar from a short-lived link, so we never handle their Google password. */
function ConnectCalendar({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const link = useAsync(() => api.get<{ url: string; expiresInMinutes: number }>(`/v1/consultant/resources/${resource.id}/connect-link`));
  const [copied, copy] = useCopy();
  return (
    <Modal title={`Connect Google Calendar · ${resource.name}`} onClose={onClose}>
      <p>Open this link (or send it to the doctor) and approve access to their calendar. It works once for this practitioner and expires soon.</p>
      <Alert>{link.error}</Alert>
      {link.loading && <Spinner />}
      {link.data && (
        <>
          <div className="copy-box"><code>{link.data.url}</code><Button small variant="secondary" onClick={() => copy(link.data!.url)}>{copied ? "Copied" : "Copy"}</Button></div>
          <p className="muted small">Valid for {link.data.expiresInMinutes} minutes.</p>
          <div className="form-foot"><a className="btn btn-primary" href={link.data.url} target="_blank" rel="noopener noreferrer">Open link</a></div>
        </>
      )}
    </Modal>
  );
}

function PractitionerForm({ resource, onClose, onSaved }: { resource: Resource | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(resource?.name ?? "");
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (resource) await api.put(`/v1/consultant/resources/${resource.id}`, { name });
      else await api.post("/v1/consultant/resources", { name });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Modal title={resource ? "Rename practitioner" : "Add a practitioner"} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name" hint="A doctor, therapist or a room — whatever gets booked."><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={100} placeholder="Dr. Rao" /></Field>
        <Alert>{error}</Alert>
        <div className="form-foot"><Button type="submit">{resource ? "Save" : "Add practitioner"}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}

type Dialog = { kind: "form"; resource: Resource | null } | { kind: "hours" | "calendar"; resource: Resource } | null;

export function PractitionersPage() {
  const list = useAsync(async () => (await api.get<{ resources: Resource[] }>("/v1/consultant/resources")).resources);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState("");

  async function toggle(r: Resource) {
    try {
      setError("");
      await api.put(`/v1/consultant/resources/${r.id}`, { active: !r.active });
      await list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const calendarBadge = (r: Resource) =>
    r.googleConnectionStatus === "connected" ? <Badge tone="good">Calendar connected</Badge> : r.googleConnectionStatus === "error" ? <Badge tone="bad">Calendar error</Badge> : <Badge>No calendar</Badge>;

  return (
    <>
      <PageHeader title="Practitioners" subtitle="Who or what is booked, their working hours and calendar." actions={<Button onClick={() => setDialog({ kind: "form", resource: null })}>Add practitioner</Button>} />
      <Alert>{error || list.error}</Alert>
      {list.loading && !list.data && <Spinner />}
      {list.data?.length === 0 && <Card><Empty>No practitioners yet. Add one, then set their hours.</Empty></Card>}
      {list.data?.map((r) => (
        <Card key={r.id}>
          <div className="card-head" style={{ marginBottom: 0 }}>
            <div><h2>{r.name}</h2><div style={{ marginTop: 6, display: "flex", gap: 6 }}>{r.active ? <Badge tone="good">Active</Badge> : <Badge>Off</Badge>}{calendarBadge(r)}</div></div>
            <div className="card-actions" style={{ flexWrap: "wrap" }}>
              <Button small onClick={() => setDialog({ kind: "hours", resource: r })}>Working hours</Button>
              <Button small variant="secondary" onClick={() => setDialog({ kind: "calendar", resource: r })}>{r.googleConnectionStatus === "connected" ? "Reconnect calendar" : "Connect Google Calendar"}</Button>
              <Button small variant="secondary" onClick={() => setDialog({ kind: "form", resource: r })}>Rename</Button>
              <Button small variant="ghost" onClick={() => toggle(r)}>{r.active ? "Turn off" : "Turn on"}</Button>
            </div>
          </div>
        </Card>
      ))}
      {dialog?.kind === "form" && <PractitionerForm resource={dialog.resource} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void list.reload(); }} />}
      {dialog?.kind === "hours" && <HoursEditor resource={dialog.resource} onClose={() => setDialog(null)} />}
      {dialog?.kind === "calendar" && <ConnectCalendar resource={dialog.resource} onClose={() => setDialog(null)} />}
    </>
  );
}

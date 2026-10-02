import { useState, type FormEvent } from "react";
import { api } from "../api";
import { errorMessage } from "../../shared/http";
import { useAsync } from "../../shared/hooks";
import { Alert, Badge, Button, Card, Empty, Field, Modal, PageHeader, Spinner } from "../../shared/ui";
import type { Service } from "../types";

function ServiceForm({ service, onClose, onSaved }: { service: Service | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(service?.name ?? "");
  const [duration, setDuration] = useState(String(service?.durationMinutes ?? 30));
  const [buffer, setBuffer] = useState(String(service?.bufferMinutes ?? 0));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = { name, durationMinutes: Number(duration), bufferMinutes: Number(buffer) };
    try {
      if (service) await api.put(`/v1/consultant/services/${service.id}`, body);
      else await api.post("/v1/consultant/services", body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={service ? "Edit service" : "Add a service"} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={100} placeholder="General consultation" /></Field>
        <div className="form-row">
          <Field label="Duration (minutes)"><input type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} required /></Field>
          <Field label="Buffer after (minutes)" hint="Gap kept free after each visit"><input type="number" min={0} max={120} step={5} value={buffer} onChange={(e) => setBuffer(e.target.value)} /></Field>
        </div>
        <Alert>{error}</Alert>
        <div className="form-foot"><Button type="submit" disabled={busy}>{service ? "Save changes" : "Add service"}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}

export function ServicesPage() {
  const list = useAsync(async () => (await api.get<{ services: Service[] }>("/v1/consultant/services")).services);
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [error, setError] = useState("");

  async function toggle(s: Service) {
    try {
      setError("");
      await api.put(`/v1/consultant/services/${s.id}`, { active: !s.active });
      await list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader title="Services" subtitle="What users can book. Turning one off hides it from the chat but keeps past appointments." actions={<Button onClick={() => setEditing("new")}>Add service</Button>} />
      <Alert>{error || list.error}</Alert>
      <Card>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty>No services yet. Add one so users can book.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Duration</th><th>Buffer</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.data.map((s) => (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong></td>
                    <td>{s.durationMinutes} min</td>
                    <td>{s.bufferMinutes} min</td>
                    <td>{s.active ? <Badge tone="good">Active</Badge> : <Badge>Off</Badge>}</td>
                    <td className="right"><div className="row-actions" style={{ justifyContent: "flex-end" }}><Button small variant="secondary" onClick={() => setEditing(s)}>Edit</Button><Button small variant="ghost" onClick={() => toggle(s)}>{s.active ? "Turn off" : "Turn on"}</Button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <ServiceForm service={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
    </>
  );
}

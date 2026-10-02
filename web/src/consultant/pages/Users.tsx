import { useState } from "react";
import { api } from "../api";
import { humanize } from "../../shared/format";
import { useClinic } from "../clinic";
import { useAsync } from "../../shared/hooks";
import { Alert, Badge, Card, Empty, Modal, PageHeader, Spinner } from "../../shared/ui";
import type { User, UserAppointment } from "../types";
import { statusTone } from "./Appointments";

function UserDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const clinic = useClinic();
  const d = useAsync(() => api.get<{ user: User; appointments: UserAppointment[] }>(`/v1/consultant/users/${id}`));
  const u = d.data?.user;
  return (
    <Modal title={u?.name ?? "User"} onClose={onClose} wide>
      <Alert>{d.error}</Alert>
      {d.loading && <Spinner />}
      {u && (
        <>
          <p className="muted">
            +{u.phoneNormalized} {u.phoneVerified ? <Badge tone="good">verified</Badge> : <Badge>unverified</Badge>}
            {u.email && <> · {u.email}</>}{u.preferredLanguage && <> · {u.preferredLanguage}</>}
            {u.dateOfBirth && <> · born {new Date(`${u.dateOfBirth}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" })}</>}
          </p>
          <p className="muted small">First seen {clinic.date(u.firstSeenAt)} via {u.firstChannel ?? "unknown"} · last seen {clinic.date(u.lastSeenAt)}</p>
          <h3>Appointments</h3>
          {d.data!.appointments.length === 0 ? <Empty>No appointments yet.</Empty> : (
            <ul className="list">
              {d.data!.appointments.map((a) => (
                <li key={a.id}><span>{clinic.when(a.start_at)} · {a.service_name} with {a.resource_name} <span className="muted">({a.channel})</span></span><Badge tone={statusTone(a.status)}>{humanize(a.status)}</Badge></li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}

/** The end users who have chatted or booked. They are created automatically from their phone number — no sign-up. */
export function UsersPage() {
  const clinic = useClinic();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = useAsync(async () => (await api.get<{ users: User[] }>(`/v1/consultant/users?limit=100${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}`)).users, [query]);
  return (
    <>
      <PageHeader title="Users" subtitle="People who chatted or booked. A profile is created from their phone number automatically." />
      <div className="toolbar"><input type="search" placeholder="Search name, email or phone…" aria-label="Search users" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <Alert>{list.error}</Alert>
      <Card>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty>{query ? "No users match." : "No users yet. They appear after their first message."}</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>First seen</th><th>Last seen</th></tr></thead>
              <tbody>
                {list.data.map((u) => (
                  <tr key={u.id} className="clickable" onClick={() => setOpen(u.id)}>
                    <td><a href={`#/users`} onClick={(e) => { e.preventDefault(); setOpen(u.id); }}>{u.name ?? "Unnamed"}</a></td>
                    <td>+{u.phoneNormalized} {u.phoneVerified && <Badge tone="good">verified</Badge>}</td>
                    <td>{u.email ?? "—"}</td>
                    <td>{clinic.date(u.firstSeenAt)}</td>
                    <td>{clinic.date(u.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && <UserDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

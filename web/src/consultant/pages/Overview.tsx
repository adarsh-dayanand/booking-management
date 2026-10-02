import { api } from "../api";
import { formatRupees, humanize } from "../../shared/format";
import { useClinic } from "../clinic";
import { useAsync } from "../../shared/hooks";
import { Alert, Badge, Button, Card, Empty, PageHeader, Spinner, Stat } from "../../shared/ui";
import type { Availability, Overview, Resource, Service } from "../types";
import { statusTone } from "./Appointments";

/** First-run guidance: a consultant can't take bookings until these four things exist. */
function SetupChecklist({ go }: { go: (to: string) => void }) {
  const setup = useAsync(async () => {
    const [{ services }, { resources }] = await Promise.all([
      api.get<{ services: Service[] }>("/v1/consultant/services"),
      api.get<{ resources: Resource[] }>("/v1/consultant/resources"),
    ]);
    const active = resources.filter((r) => r.active);
    const hours = await Promise.all(active.map((r) => api.get<Availability>(`/v1/consultant/resources/${r.id}/availability`)));
    return {
      service: services.some((s) => s.active),
      practitioner: active.length > 0,
      hours: hours.some((h) => h.weekly.length > 0),
      calendar: active.some((r) => r.googleConnectionStatus === "connected"),
    };
  });
  const s = setup.data;
  if (!s || (s.service && s.practitioner && s.hours)) return null;
  const items: [boolean, string, string, string][] = [
    [s.service, "Add a service", "What patients can book, and for how long", "/services"],
    [s.practitioner, "Add a practitioner", "The doctor or room that is booked", "/practitioners"],
    [s.hours, "Set working hours", "Patients can only book inside these hours", "/practitioners"],
    [s.calendar, "Connect Google Calendar (optional)", "Keeps availability in sync with a real calendar", "/practitioners"],
  ];
  return (
    <Card title="Finish setting up">
      <ul className="list checklist">
        {items.map(([done, title, why, to]) => (
          <li key={title}>
            <span><span className={done ? "tick" : "todo"}>{done ? "✓" : "○"}</span> <strong>{title}</strong> <span className="muted">— {why}</span></span>
            {!done && <Button small variant="secondary" onClick={() => go(to)}>Set up</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function OverviewPage({ go }: { go: (to: string) => void }) {
  const clinic = useClinic();
  const { data: o, error, loading } = useAsync(() => api.get<Overview>("/v1/consultant/overview"));
  return (
    <>
      <PageHeader title="Overview" subtitle={o ? `Times shown in ${o.timezone}` : undefined} />
      <Alert>{error}</Alert>
      {loading && !o && <Spinner />}
      <SetupChecklist go={go} />
      {o && (
        <>
          {o.syncFailed > 0 && (
            <Alert kind="warning">
              {o.syncFailed} appointment{o.syncFailed > 1 ? "s" : ""} failed to sync to Google Calendar.{" "}
              <a href="#/appointments/all" onClick={(e) => { e.preventDefault(); go("/appointments/all"); }}>Review and retry</a>
            </Alert>
          )}
          <div className="stats">
            <Stat label="Today" value={o.today} hint="appointments" />
            <Stat label="Next 7 days" value={o.next7Days} hint="appointments" />
            <button className="stat" style={{ textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit" }} onClick={() => go("/appointments/needs-approval")}>
              <div className="stat-label">Needs your approval</div>
              <div className="stat-value" style={o.pendingApproval ? { color: "var(--warn)" } : undefined}>{o.pendingApproval}</div>
            </button>
            {o.paymentsActive && <Stat label="Awaiting payment" value={o.awaitingPayment} hint="slots held" />}
            <Stat label="Users" value={o.users} hint={`${o.newUsers30d} new in 30 days`} />
            {o.paymentsActive && <Stat label="Revenue, 30 days" value={formatRupees(o.revenue.last30DaysPaise)} hint={`${formatRupees(o.revenue.todayPaise)} today · ${o.revenue.paidCount30d} payments`} tone="good" />}
          </div>
          <Card title="Next appointments" actions={<Button small variant="secondary" onClick={() => go("/appointments/upcoming")}>View all</Button>}>
            {o.upcoming.length === 0 ? (
              <Empty>No upcoming appointments.</Empty>
            ) : (
              <ul className="list">
                {o.upcoming.map((a) => (
                  <li key={a.id}>
                    <span><strong>{clinic.when(a.start_at)}</strong> · {a.patient_name ?? "Unnamed"} <span className="muted">— {a.service_name} with {a.resource_name}</span></span>
                    <Badge tone={statusTone(a.status)}>{humanize(a.status)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}

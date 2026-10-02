import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { formatRupees, formatWhen } from "../format";
import type { Appointment } from "../types";

type Action = "approve" | "reject" | "cancel" | "retry-sync";

export function AppointmentsTable() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setAppointments((await api.get<{ appointments: Appointment[] }>("/v1/consultant/appointments")).appointments);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load appointments");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: Action) {
    try {
      await api.send("POST", `/v1/consultant/appointments/${id}/${action}`);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Action failed");
    }
  }

  return (
    <>
      <h2>Appointments</h2>
      {error && <div className="error" role="alert">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>When</th><th>User</th><th>Service</th><th>Practitioner</th><th>Channel</th><th>Status</th><th>Payment</th><th>Calendar</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {appointments.map((a) => (
            <tr key={a.id}>
              <td>{formatWhen(a.start_at)}</td>
              <td>{a.patient_name}<br /><small>{a.patient_phone}</small></td>
              <td>{a.service_name}</td>
              <td>{a.resource_name}</td>
              <td>{a.channel}</td>
              <td><span className={`status ${a.status}`}>{a.status}</span></td>
              <td>
                {a.payment_status ? (
                  <>
                    <span className={a.payment_status === "paid" ? "pay-paid" : ""}>{a.payment_status}</span>
                    <br /><small>{formatRupees(a.amount_paise ?? 0)}</small>
                  </>
                ) : "—"}
              </td>
              <td>{a.calendar_sync_status}</td>
              <td className="actions">
                {a.status === "PENDING_CONFIRMATION" && (
                  <>
                    <button onClick={() => act(a.id, "approve")}>Approve</button>
                    <button className="danger" onClick={() => act(a.id, "reject")}>Reject</button>
                  </>
                )}
                {(a.status === "AWAITING_PAYMENT" || a.status === "PENDING_CONFIRMATION" || a.status === "CONFIRMED") && (
                  <button className="danger" onClick={() => act(a.id, "cancel")}>Cancel</button>
                )}
                {a.calendar_sync_status === "failed" && <button onClick={() => act(a.id, "retry-sync")}>Retry sync</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

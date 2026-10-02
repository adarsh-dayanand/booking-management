import { useEffect, useState } from "react";
import { useHashRoute } from "../shared/hooks";
import { Shell } from "../shared/ui";
import { api, tokens, unauthorizedListeners } from "./api";
import { ClinicContext, DEFAULT_CLINIC, type Clinic } from "./clinic";
import { LoginForm } from "./LoginForm";
import { AppointmentsPage } from "./pages/Appointments";
import { OverviewPage } from "./pages/Overview";
import { PaymentsPage } from "./pages/Payments";
import { PractitionersPage } from "./pages/Practitioners";
import { ServicesPage } from "./pages/Services";
import { SettingsPage } from "./pages/Settings";
import { UsersPage } from "./pages/Users";
import type { Settings } from "./types";

const NAV = [
  { id: "overview", label: "Overview" },
  { id: "appointments", label: "Appointments" },
  { id: "users", label: "Users" },
  { id: "services", label: "Services" },
  { id: "practitioners", label: "Practitioners" },
  { id: "payments", label: "Payments" },
  { id: "settings", label: "Settings" },
];

const toClinic = (s: Settings): Clinic => ({ name: s.name, timezone: s.timezone, slotIntervalMinutes: s.slotIntervalMinutes });

export function App() {
  const [token, setToken] = useState<string | null>(() => tokens.get());
  const [route, navigate] = useHashRoute("/overview");
  const [clinic, setClinic] = useState<Clinic>(DEFAULT_CLINIC);

  // An expired session on any call drops back to the login screen.
  useEffect(() => {
    const onExpired = () => setToken(null);
    unauthorizedListeners.add(onExpired);
    return () => void unauthorizedListeners.delete(onExpired);
  }, []);

  useEffect(() => {
    if (token) api.get<{ settings: Settings }>("/v1/consultant/settings").then((r) => setClinic(toClinic(r.settings))).catch(() => undefined);
  }, [token]);

  if (!token) {
    return <LoginForm onLoggedIn={(t) => { tokens.set(t); setToken(t); }} />;
  }

  const [, page, sub] = route.split("/");
  return (
    <ClinicContext.Provider value={clinic}>
    <Shell
      area="Consultant"
      account={clinic.name}
      nav={NAV}
      route={route}
      onNavigate={navigate}
      onLogout={() => { tokens.clear(); setToken(null); }}
    >
      {page === "appointments" ? <AppointmentsPage filter={sub} onFilter={(f) => navigate(`/appointments/${f}`)} />
        : page === "users" ? <UsersPage />
        : page === "services" ? <ServicesPage />
        : page === "practitioners" ? <PractitionersPage />
        : page === "payments" ? <PaymentsPage />
        : page === "settings" ? <SettingsPage onSaved={(s) => setClinic(toClinic(s))} />
        : <OverviewPage go={navigate} />}
    </Shell>
    </ClinicContext.Provider>
  );
}

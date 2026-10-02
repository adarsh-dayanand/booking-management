import { useEffect, useState } from "react";
import { useHashRoute } from "../shared/hooks";
import { Shell } from "../shared/ui";
import { tokens, unauthorizedListeners } from "./api";
import { ConsultantDetail } from "./pages/ConsultantDetail";
import { ConsultantsPage } from "./pages/Consultants";
import { OverviewPage } from "./pages/Overview";
import { TokenLogin } from "./TokenLogin";

const NAV = [
  { id: "overview", label: "Overview" },
  { id: "consultants", label: "Consultants" },
];

export function App() {
  const [authed, setAuthed] = useState(() => Boolean(tokens.get()));
  const [route, navigate] = useHashRoute("/overview");

  useEffect(() => {
    const onExpired = () => setAuthed(false);
    unauthorizedListeners.add(onExpired);
    return () => void unauthorizedListeners.delete(onExpired);
  }, []);

  if (!authed) return <TokenLogin onLoggedIn={() => setAuthed(true)} />;

  const [, page, slug] = route.split("/");
  return (
    <Shell area="Admin" nav={NAV} route={route} onNavigate={navigate} onLogout={() => { tokens.clear(); setAuthed(false); }}>
      {page === "consultants" && slug ? <ConsultantDetail slug={slug} back={() => navigate("/consultants")} />
        : page === "consultants" ? <ConsultantsPage open={(s) => navigate(`/consultants/${s}`)} />
        : <OverviewPage go={navigate} />}
    </Shell>
  );
}

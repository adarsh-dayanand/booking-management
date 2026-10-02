import { useEffect, useState } from "react";
import { tokenStore, unauthorizedListeners } from "./api";
import { AppointmentsTable } from "./components/AppointmentsTable";
import { FeesCard } from "./components/FeesCard";
import { LoginForm } from "./components/LoginForm";

export function App() {
  const [token, setToken] = useState<string | null>(() => tokenStore.get());

  // An expired session on any call drops back to the login screen.
  useEffect(() => {
    const onExpired = () => setToken(null);
    unauthorizedListeners.add(onExpired);
    return () => void unauthorizedListeners.delete(onExpired);
  }, []);

  function logout() {
    tokenStore.clear();
    setToken(null);
  }

  return (
    <>
      <header>
        <strong>Consultant Dashboard</strong>
        {token && <button onClick={logout}>Log out</button>}
      </header>
      <main>
        {token ? (
          <>
            <FeesCard />
            <AppointmentsTable />
          </>
        ) : (
          <LoginForm
            onLoggedIn={(t) => {
              tokenStore.set(t);
              setToken(t);
            }}
          />
        )}
      </main>
    </>
  );
}

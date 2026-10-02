import { useState, type FormEvent } from "react";
import { Alert, Button, Field, LoginLayout } from "../shared/ui";
import { errorMessage } from "../shared/http";
import { api } from "./api";

export function LoginForm({ onLoggedIn }: { onLoggedIn: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      onLoggedIn((await api.anonymous<{ token: string }>("POST", "/v1/consultant/login", { email, password })).token);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoginLayout
      area="Consultant"
      title="Consultant login"
      subtitle="Sign in to manage your bookings, services and fees."
      alt={<>Platform operator? <a href="/admin/">Open the admin console</a></>}
    >
      <form onSubmit={submit}>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></Field>
        <Field label="Password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></Field>
        <Alert>{error}</Alert>
        <Button type="submit" disabled={busy}>Log in</Button>
      </form>
    </LoginLayout>
  );
}

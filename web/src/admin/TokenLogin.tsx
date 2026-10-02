import { useState, type FormEvent } from "react";
import { ApiError } from "../shared/http";
import { Alert, Button, Field, LoginLayout } from "../shared/ui";
import { tokens } from "./api";

/** The admin API has no accounts: the operator pastes the ADMIN_TOKEN set on the server. We verify it with a real call. */
export function TokenLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/v1/admin/overview", { headers: { Authorization: `Bearer ${token.trim()}` } });
      if (res.status === 403) throw new ApiError("The admin API is switched off. Set ADMIN_TOKEN in the server's .env and restart it.", 403);
      if (res.status === 401) throw new ApiError("That token isn't right. Use the ADMIN_TOKEN value from the server's .env.", 401);
      if (!res.ok) throw new ApiError("Couldn't reach the admin API. Is the server running?", res.status);
      tokens.set(token.trim());
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server. Is it running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoginLayout
      area="Admin"
      title="Admin console"
      subtitle="Platform operator access. Paste the admin token to continue."
      alt={<>Running a clinic? <a href="/consultant/">Consultant sign-in</a></>}
    >
      <form onSubmit={submit}>
        <Field label="Admin token" hint="The ADMIN_TOKEN value from the server's .env file."><input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" spellCheck={false} /></Field>
        <Alert>{error}</Alert>
        <Button type="submit" disabled={busy || !token.trim()}>Continue</Button>
      </form>
    </LoginLayout>
  );
}

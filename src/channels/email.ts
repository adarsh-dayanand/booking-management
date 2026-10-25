import { config } from "../config";

export const isEmailConfigured = (): boolean => Boolean(config.email.resendApiKey && config.email.from);

/** Sends a plain-text email to each address through Resend, one message each so recipients don't see one another. Throws on failure; callers treat that as non-fatal. */
export async function sendEmail(to: string[], subject: string, text: string): Promise<void> {
  if (!isEmailConfigured() || to.length === 0) return;
  await Promise.all(
    to.map(async (address) => {
      const response = await fetch(`${config.email.apiBase}/emails`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.email.resendApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: config.email.from, to: [address], subject, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Resend email failed (${response.status}): ${await response.text()}`);
    })
  );
}

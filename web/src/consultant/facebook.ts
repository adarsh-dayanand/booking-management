// Meta's Embedded Signup runs in a Facebook-hosted popup. The popup reports two things, in either order: an
// authorization `code` (through FB.login's callback) and which WhatsApp account and number the person picked
// (through a window message from facebook.com). The server needs both.

interface FBSdk {
  init(opts: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void;
  login(callback: (response: { authResponse?: { code?: string } | null }) => void, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    FB?: FBSdk;
    fbAsyncInit?: () => void;
  }
}

export interface SignupResult { code: string; phoneNumberId: string; wabaId: string }
export interface SignupConfig { appId: string; configId: string; graphVersion: string }

const SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
const FB_ORIGINS = ["https://www.facebook.com", "https://web.facebook.com"];

let initialisedFor: string | null = null;

function loadSdk(config: SignupConfig): Promise<FBSdk> {
  const ready = () => {
    if (initialisedFor !== config.appId) {
      window.FB!.init({ appId: config.appId, autoLogAppEvents: true, xfbml: true, version: config.graphVersion });
      initialisedFor = config.appId;
    }
    return window.FB!;
  };
  if (window.FB) return Promise.resolve(ready());
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => resolve(ready());
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("Couldn't load Facebook's sign-in. Check your connection or any ad/script blocker, then try again."));
    document.head.appendChild(script);
  });
}

/** Opens Meta's popup and resolves with everything the server needs, or rejects with a message fit to show the person. */
export async function runEmbeddedSignup(config: SignupConfig, timeoutMs = 5 * 60_000): Promise<SignupResult> {
  const fb = await loadSdk(config);
  return new Promise((resolve, reject) => {
    let code: string | undefined;
    let chosen: { phoneNumberId: string; wabaId: string } | undefined;
    let settled = false;
    const timer = setTimeout(() => fail("Timed out waiting for Meta. Please try again."), timeoutMs);

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    const fail = (message: string) => {
      if (settled) return;
      cleanup();
      reject(new Error(message));
    };
    const maybeFinish = () => {
      if (settled || !code || !chosen) return;
      cleanup();
      resolve({ code, ...chosen });
    };

    function onMessage(event: MessageEvent) {
      if (!FB_ORIGINS.includes(event.origin)) return; // only Facebook's popup is trusted to say which number was chosen
      let data: any;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event === "FINISH" && data.data?.phone_number_id && data.data?.waba_id) {
        chosen = { phoneNumberId: String(data.data.phone_number_id), wabaId: String(data.data.waba_id) };
        maybeFinish();
      } else if (data.event === "CANCEL") {
        fail("You closed the WhatsApp sign-up before finishing.");
      } else if (data.event === "ERROR") {
        fail(data.data?.error_message || "Meta reported an error during sign-up.");
      }
    }
    window.addEventListener("message", onMessage);

    fb.login(
      (response) => {
        if (response.authResponse?.code) {
          code = response.authResponse.code;
          maybeFinish();
        } else {
          fail("The Facebook login was cancelled or didn't complete.");
        }
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      }
    );
  });
}

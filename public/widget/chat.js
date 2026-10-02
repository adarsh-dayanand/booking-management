const API_BASE = window.location.origin;
const params = new URLSearchParams(window.location.search);
const tenant = params.get("tenant");

const messagesEl = document.getElementById("messages");
const form = document.getElementById("composer");
const input = document.getElementById("input");

function sessionId() {
  try {
    let id = localStorage.getItem("booking_session_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("booking_session_id", id);
    }
    return id;
  } catch {
    // Private browsing / storage blocked: fall back to a per-load id. The
    // conversation just won't survive a page reload in that case.
    return crypto.randomUUID();
  }
}
const currentSessionId = sessionId();

function addMessage(text, from) {
  const div = document.createElement("div");
  div.className = `message ${from}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addOptions(options) {
  const wrap = document.createElement("div");
  wrap.className = "options";
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt.label;
    btn.addEventListener("click", () => send(opt.id, opt.label));
    wrap.appendChild(btn);
  }
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Payment: show a Pay button, then watch for the payment to land and say so in the chat.
function addPayment(payment) {
  const wrap = document.createElement("div");
  wrap.className = "options";
  const pay = document.createElement("a");
  pay.className = "pay-button";
  pay.href = payment.url;
  pay.target = "_blank";
  pay.rel = "noopener noreferrer";
  pay.textContent = `Pay ${payment.amount} to confirm`;
  wrap.appendChild(pay);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  watchPayment(payment, wrap);
}

function watchPayment(payment, wrap) {
  const deadline = new Date(payment.expiresAt).getTime() + 60_000;
  let stopped = false;
  const check = async () => {
    if (stopped) return;
    try {
      const res = await fetch(
        `${API_BASE}/v1/public/${encodeURIComponent(tenant)}/chat/payments/${encodeURIComponent(payment.appointmentId)}`
      );
      const data = await res.json();
      if (res.ok && data.message) {
        stopped = true;
        wrap.remove();
        addMessage(data.message, "bot");
        return;
      }
    } catch {
      /* transient: try again on the next tick */
    }
    if (Date.now() > deadline) {
      stopped = true;
      return;
    }
    setTimeout(check, 5000);
  };
  setTimeout(check, 5000);
}

async function send(message, displayText) {
  if (displayText !== undefined) addMessage(displayText, "user");
  try {
    const res = await fetch(`${API_BASE}/v1/public/${encodeURIComponent(tenant)}/chat/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId, message }),
    });
    const data = await res.json();
    if (!res.ok) {
      addMessage(data.error || "Sorry, something went wrong. Please try again.", "bot");
      return;
    }
    addMessage(data.replyText, "bot");
    if (data.options?.length) addOptions(data.options);
    if (data.payment) addPayment(data.payment);
  } catch {
    addMessage("Sorry, I couldn't reach the server. Please check your connection and try again.", "bot");
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  send(text, text);
});

if (!tenant) {
  addMessage("This chat widget is missing its clinic configuration (no ?tenant= set).", "bot");
} else {
  send("hello"); // brand-new conversations get the greeting regardless of what's sent
}

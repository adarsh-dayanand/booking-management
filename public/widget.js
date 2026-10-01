// Embeddable booking chat widget. A clinic pastes:
//   <script src="https://<your-domain>/widget.js" data-tenant="clinic-slug" defer></script>
// into their own site. This file runs on THEIR page and only ever injects a
// same-origin iframe pointing back at us — it never talks to our API directly,
// so the clinic's site needs no CORS setup and shares no credentials with us.
(function () {
  var scriptEl = document.currentScript;
  if (!scriptEl) return;

  var tenant = scriptEl.getAttribute("data-tenant");
  if (!tenant) {
    console.error("[booking-widget] missing required data-tenant attribute on the widget <script> tag");
    return;
  }

  var origin = new URL(scriptEl.src, window.location.href).origin;

  var bubble = document.createElement("button");
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open chat to book an appointment");
  bubble.textContent = "💬";
  Object.assign(bubble.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    width: "56px",
    height: "56px",
    borderRadius: "50%",
    border: "none",
    background: "#2563eb",
    color: "#fff",
    fontSize: "24px",
    lineHeight: "56px",
    textAlign: "center",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
    zIndex: "2147483000",
  });

  var panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    bottom: "88px",
    right: "20px",
    width: "360px",
    maxWidth: "90vw",
    height: "520px",
    maxHeight: "75vh",
    borderRadius: "12px",
    overflow: "hidden",
    boxShadow: "0 8px 30px rgba(0,0,0,0.3)",
    display: "none",
    zIndex: "2147483000",
    background: "#fff",
  });

  var iframe = document.createElement("iframe");
  iframe.src = origin + "/widget/chat.html?tenant=" + encodeURIComponent(tenant);
  iframe.title = "Book an appointment";
  Object.assign(iframe.style, { width: "100%", height: "100%", border: "none" });
  panel.appendChild(iframe);

  var isOpen = false;
  bubble.addEventListener("click", function () {
    isOpen = !isOpen;
    panel.style.display = isOpen ? "block" : "none";
    bubble.textContent = isOpen ? "✕" : "💬";
  });

  function mount() {
    document.body.appendChild(panel);
    document.body.appendChild(bubble);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();

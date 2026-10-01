const API_BASE = window.location.origin;
const TOKEN_KEY = "booking_admin_token";

const loginForm = document.getElementById("login-form");
const dashboard = document.getElementById("dashboard");
const logoutBtn = document.getElementById("logout");
const errorEl = document.getElementById("error");
const tbody = document.getElementById("appointments-body");

const getToken = () => localStorage.getItem(TOKEN_KEY);

function showDashboard() {
  loginForm.style.display = "none";
  dashboard.style.display = "block";
  logoutBtn.style.display = "inline-block";
  loadAppointments();
}

function showLogin() {
  loginForm.style.display = "block";
  dashboard.style.display = "none";
  logoutBtn.style.display = "none";
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}`, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
    throw new Error("Session expired, please log in again");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

const formatWhen = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function actionButton(label, action, id, danger) {
  const btn = document.createElement("button");
  btn.textContent = label;
  if (danger) btn.classList.add("danger");
  btn.addEventListener("click", async () => {
    try {
      await api(`/v1/admin/appointments/${id}/${action}`, { method: "POST", body: JSON.stringify({}) });
      loadAppointments();
    } catch (err) {
      alert(err.message);
    }
  });
  return btn;
}

async function loadAppointments() {
  try {
    const { appointments } = await api("/v1/admin/appointments");
    tbody.innerHTML = "";
    for (const a of appointments) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatWhen(a.start_at)}</td>
        <td>${a.patient_name}<br><small>${a.patient_phone}</small></td>
        <td>${a.service_name}</td>
        <td>${a.resource_name}</td>
        <td>${a.channel}</td>
        <td><span class="status ${a.status}">${a.status}</span></td>
        <td>${a.calendar_sync_status}</td>
        <td class="actions"></td>
      `;
      const actionsCell = tr.querySelector(".actions");
      if (a.status === "PENDING_CONFIRMATION") {
        actionsCell.appendChild(actionButton("Approve", "approve", a.id));
        actionsCell.appendChild(actionButton("Reject", "reject", a.id, true));
      }
      if (a.status === "PENDING_CONFIRMATION" || a.status === "CONFIRMED") {
        actionsCell.appendChild(actionButton("Cancel", "cancel", a.id, true));
      }
      if (a.calendar_sync_status === "failed") {
        actionsCell.appendChild(actionButton("Retry sync", "retry-sync", a.id));
      }
      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error(err);
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.textContent = "";
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  try {
    const res = await fetch(`${API_BASE}/v1/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    localStorage.setItem(TOKEN_KEY, data.token);
    showDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
});

if (getToken()) showDashboard();
else showLogin();

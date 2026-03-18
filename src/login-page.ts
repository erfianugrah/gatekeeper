/**
 * Login page HTML — served at GET /login.
 *
 * Handles both login and bootstrap (first-run) flows.
 * Matches the Gatekeeper dashboard visual style (dark theme, purple accents).
 */

export function renderLoginPage(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign in — Gatekeeper</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background-color: #15161e;
  color: #fcfcfc;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

.backdrop-glow {
  position: fixed;
  inset: 0;
  background: radial-gradient(ellipse 600px 400px at 50% 45%, rgba(197,116,221,0.08) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

.card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 380px;
  padding: 2.5rem;
  background: #1e1f2e;
  border: 1px solid #2a2b3d;
  border-radius: 12px;
  animation: fadeIn 0.5s ease-out both;
}

.shield {
  display: block;
  width: 48px;
  height: 48px;
  margin: 0 auto 1.5rem;
}
.shield path { stroke: #c574dd; }
.shield circle, .shield rect { fill: #c574dd; }

.title {
  font-size: 1.25rem;
  font-weight: 700;
  text-align: center;
  margin-bottom: 0.25rem;
  color: #fcfcfc;
}

.subtitle {
  font-size: 0.8rem;
  color: #8b8c9e;
  text-align: center;
  margin-bottom: 1.5rem;
}

.field { margin-bottom: 1rem; }

.field label {
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  color: #bdbdc1;
  margin-bottom: 0.35rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.field input {
  width: 100%;
  padding: 0.6rem 0.75rem;
  background: #15161e;
  border: 1px solid #343647;
  border-radius: 6px;
  color: #fcfcfc;
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.2s;
}
.field input:focus {
  border-color: #c574dd;
}

.btn {
  display: block;
  width: 100%;
  padding: 0.65rem;
  margin-top: 1.25rem;
  background: linear-gradient(135deg, #c574dd, #8796f4);
  color: #fff;
  font-size: 0.9rem;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: opacity 0.2s;
}
.btn:hover { opacity: 0.9; }
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error {
  display: none;
  margin-top: 1rem;
  padding: 0.6rem 0.75rem;
  background: rgba(239,68,68,0.1);
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: 6px;
  color: #ef4444;
  font-size: 0.8rem;
  text-align: center;
}
.error.visible { display: block; }

.info {
  margin-top: 1rem;
  padding: 0.6rem 0.75rem;
  background: rgba(197,116,221,0.08);
  border: 1px solid rgba(197,116,221,0.2);
  border-radius: 6px;
  color: #c574dd;
  font-size: 0.75rem;
  text-align: center;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
</style>
</head>
<body>
<div class="backdrop-glow"></div>
<div class="card">
  <svg class="shield" viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linejoin="round">
    <path d="M12 2 L3 6.5 L3 12 C3 18.5 6.8 23 12 24.5 C17.2 23 21 18.5 21 12 L21 6.5 Z" />
    <circle cx="12" cy="11" r="2.5" />
    <rect x="11" y="13" width="2" height="4" rx="0.8" />
  </svg>

  <div id="login-view">
    <div class="title">Sign in</div>
    <div class="subtitle">Gatekeeper Dashboard</div>
    <form id="login-form">
      <div class="field">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" required autocomplete="email" autofocus>
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit" class="btn" id="login-btn">Sign in</button>
      <div class="error" id="login-error"></div>
    </form>
  </div>

  <div id="bootstrap-view" style="display:none;">
    <div class="title">Welcome</div>
    <div class="subtitle">Create your admin account to get started</div>
    <div class="info">No users exist yet. This form creates the first admin account.</div>
    <form id="bootstrap-form" style="margin-top: 1rem;">
      <div class="field">
        <label for="bs-email">Email</label>
        <input type="email" id="bs-email" name="email" required autocomplete="email" autofocus>
      </div>
      <div class="field">
        <label for="bs-password">Password</label>
        <input type="password" id="bs-password" name="password" required autocomplete="new-password" minlength="12">
      </div>
      <div class="field">
        <label for="bs-confirm">Confirm password</label>
        <input type="password" id="bs-confirm" name="confirm" required autocomplete="new-password" minlength="12">
      </div>
      <button type="submit" class="btn" id="bootstrap-btn">Create admin account</button>
      <div class="error" id="bootstrap-error"></div>
    </form>
  </div>
</div>

<script>
(function() {
  var loginView = document.getElementById("login-view");
  var bootstrapView = document.getElementById("bootstrap-view");

  // Check if bootstrap is needed (no users exist)
  fetch("/auth/session").then(function(r) {
    if (r.ok) {
      // Already logged in — go to dashboard
      window.location.replace("/dashboard/");
      return;
    }
    // Check if we need bootstrap
    return fetch("/auth/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  }).then(function(r) {
    if (!r) return;
    return r.json();
  }).then(function(data) {
    if (!data) return;
    // 400 = missing fields (bootstrap enabled), 403 = users exist (show login)
    if (data.errors && data.errors[0] && data.errors[0].code === 400) {
      loginView.style.display = "none";
      bootstrapView.style.display = "block";
    }
    // 403 = users exist, show login (default)
  }).catch(function() {
    // Network error — show login form anyway
  });

  // Login form
  document.getElementById("login-form").addEventListener("submit", function(e) {
    e.preventDefault();
    var btn = document.getElementById("login-btn");
    var errEl = document.getElementById("login-error");
    errEl.classList.remove("visible");
    btn.disabled = true;
    btn.textContent = "Signing in\u2026";

    fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email: document.getElementById("email").value,
        password: document.getElementById("password").value
      })
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.success) {
        window.location.replace("/dashboard/");
      } else {
        errEl.textContent = (data.errors && data.errors[0] && data.errors[0].message) || "Login failed";
        errEl.classList.add("visible");
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
    }).catch(function() {
      errEl.textContent = "Network error — please try again";
      errEl.classList.add("visible");
      btn.disabled = false;
      btn.textContent = "Sign in";
    });
  });

  // Bootstrap form
  document.getElementById("bootstrap-form").addEventListener("submit", function(e) {
    e.preventDefault();
    var btn = document.getElementById("bootstrap-btn");
    var errEl = document.getElementById("bootstrap-error");
    errEl.classList.remove("visible");

    var password = document.getElementById("bs-password").value;
    var confirm = document.getElementById("bs-confirm").value;
    if (password !== confirm) {
      errEl.textContent = "Passwords do not match";
      errEl.classList.add("visible");
      return;
    }
    if (password.length < 12) {
      errEl.textContent = "Password must be at least 12 characters";
      errEl.classList.add("visible");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Creating account\u2026";

    fetch("/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        email: document.getElementById("bs-email").value,
        password: password
      })
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.success) {
        window.location.replace("/dashboard/");
      } else {
        errEl.textContent = (data.errors && data.errors[0] && data.errors[0].message) || "Failed to create account";
        errEl.classList.add("visible");
        btn.disabled = false;
        btn.textContent = "Create admin account";
      }
    }).catch(function() {
      errEl.textContent = "Network error — please try again";
      errEl.classList.add("visible");
      btn.disabled = false;
      btn.textContent = "Create admin account";
    });
  });
})();
</script>
</body>
</html>`;
}

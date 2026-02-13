// Web UI page for setting environment variables (API keys).
//
// Users land here via a link from the Telegram bot. The page shows a
// prompt, a textarea for the secret value, and a submit button.
// On submit, JS calls POST /api/deployments/:deployment/env with the
// relay token — reusing the existing secure-env API endpoint.
//
// Query params:
//   deployment  — deployment ID
//   name        — secret name (e.g. ANTHROPIC_KEY)
//   prompt      — human-readable instructions to display
//   allowedHosts — comma-separated list of allowed upstream hosts
//   token       — relay token for authentication

import type { Context } from "hono"

export function setEnvPage(c: Context): Response {
  const deployment = c.req.query("deployment") ?? ""
  const name = c.req.query("name") ?? ""
  const prompt = c.req.query("prompt") ?? "Paste your API key below."
  const allowedHosts = c.req.query("allowedHosts") ?? ""
  const token = c.req.query("token") ?? ""

  if (!deployment || !name || !token) {
    return c.html(
      `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>claw.free — Missing Parameters</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
.error{color:#d32f2f;margin-top:24px}</style></head>
<body><h1>claw.free</h1><p class="error">Missing required parameters. Please use the link your bot gave you.</p></body></html>`,
      400,
    )
  }

  // Escape values for safe embedding in HTML/JS
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  const jsStr = (s: string) =>
    JSON.stringify(s)

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>claw.free — Set ${esc(name)}</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
h1{font-size:1.4rem;margin-bottom:4px}
.subtitle{color:#666;font-size:0.9rem;margin-top:0}
.prompt{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin:20px 0;line-height:1.5}
label{display:block;font-weight:600;margin-bottom:6px;font-size:0.95rem}
textarea{width:100%;min-height:80px;padding:10px;border:1px solid #ccc;border-radius:6px;font-family:monospace;font-size:0.9rem;resize:vertical}
textarea:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,0.15)}
button{margin-top:12px;padding:10px 24px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:1rem;cursor:pointer;width:100%}
button:hover{background:#1d4ed8}
button:disabled{background:#94a3b8;cursor:not-allowed}
.result{margin-top:20px;padding:16px;border-radius:8px;text-align:center}
.success{background:#dcfce7;color:#166534;border:1px solid #86efac}
.error{background:#fef2f2;color:#991b1b;border:1px solid #fca5a5}
</style>
</head>
<body>
<h1>claw.free</h1>
<p class="subtitle">Secure key setup</p>

<div class="prompt">${esc(prompt)}</div>

<form id="form">
  <label for="value">${esc(name)}</label>
  <textarea id="value" name="value" placeholder="Paste your key here..." required autocomplete="off" spellcheck="false"></textarea>
  <button type="submit" id="btn">Save</button>
</form>

<div id="result"></div>

<script>
(function() {
  var deployment = ${jsStr(deployment)};
  var name = ${jsStr(name)};
  var allowedHosts = ${jsStr(allowedHosts)}.split(",").filter(Boolean);
  var token = ${jsStr(token)};

  var form = document.getElementById("form");
  var btn = document.getElementById("btn");
  var result = document.getElementById("result");

  form.addEventListener("submit", function(e) {
    e.preventDefault();
    var value = document.getElementById("value").value.trim();
    if (!value) return;

    btn.disabled = true;
    btn.textContent = "Saving...";
    result.innerHTML = "";

    fetch("/api/deployments/" + encodeURIComponent(deployment) + "/env", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Token": token
      },
      body: JSON.stringify({
        name: name,
        value: value,
        allowedHosts: allowedHosts
      })
    })
    .then(function(res) {
      if (!res.ok) return res.json().then(function(d) { throw new Error(d.error || "Request failed"); });
      return res.json();
    })
    .then(function() {
      form.style.display = "none";
      result.className = "result success";
      result.innerHTML = "<strong>Saved!</strong><br>Go back to Telegram and say <strong>continue</strong>.";
    })
    .catch(function(err) {
      btn.disabled = false;
      btn.textContent = "Save";
      result.className = "result error";
      result.textContent = "Error: " + err.message;
    });
  });
})();
</script>
</body>
</html>`

  return c.html(html)
}

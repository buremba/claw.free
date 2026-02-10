import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const PORT = 3456;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || "/opt/openclaw/openclaw.json";

// ── State ──────────────────────────────────────────────────────────
const state = {
  stage: "welcome", // welcome | auth_started | waiting_for_code | add_another | done
  selectedProvider: process.env.LLM_PROVIDER || "claude", // claude | openai
  childProcess: null,
  authTimer: null,
  configuredProviders: [],
  capturedUrl: null,
  capturedCode: null,
};

// ── Helpers ────────────────────────────────────────────────────────
function killAuthProcess() {
  if (state.childProcess) {
    state.childProcess.kill();
    state.childProcess = null;
  }
  if (state.authTimer) {
    clearTimeout(state.authTimer);
    state.authTimer = null;
  }
}

async function readOpenClawConfig() {
  const raw = await readFile(OPENCLAW_CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

async function writeOpenClawConfig(config) {
  await writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function providerDisplayName(provider) {
  return provider === "claude" ? "Claude (Anthropic)" : "ChatGPT (OpenAI)";
}

function otherProvider(provider) {
  return provider === "claude" ? "openai" : "claude";
}

function modelId(provider) {
  if (provider === "claude") return "anthropic/claude-sonnet-4-20250514";
  return "openai/gpt-4o";
}

function providerKey(provider) {
  return provider === "claude" ? "anthropic" : "openai";
}

// ── Auth process spawning ──────────────────────────────────────────
function spawnClaudeAuth() {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["setup-token"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let urlFound = false;

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
      // Look for URL in output
      const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
      if (urlMatch && !urlFound) {
        urlFound = true;
        resolve({ process: proc, url: urlMatch[1] });
      }
    });

    proc.stderr.on("data", (data) => {
      stdout += data.toString();
      const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
      if (urlMatch && !urlFound) {
        urlFound = true;
        resolve({ process: proc, url: urlMatch[1] });
      }
    });

    proc.on("error", (err) => {
      if (!urlFound) reject(err);
    });

    proc.on("close", (code) => {
      if (!urlFound) {
        reject(new Error(`claude setup-token exited with code ${code}. Output: ${stdout}`));
      }
    });

    // Timeout for URL capture
    setTimeout(() => {
      if (!urlFound) {
        proc.kill();
        reject(new Error(`Timed out waiting for auth URL. Output so far: ${stdout}`));
      }
    }, 30_000);
  });
}

function spawnCodexAuth() {
  return new Promise((resolve, reject) => {
    const proc = spawn("codex", ["login", "--device-auth"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let infoFound = false;

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
      // Look for verification URL and code
      const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
      const codeMatch = stdout.match(/code[:\s]+([A-Z0-9-]+)/i);
      if (urlMatch && codeMatch && !infoFound) {
        infoFound = true;
        resolve({ process: proc, url: urlMatch[1], code: codeMatch[1] });
      }
    });

    proc.stderr.on("data", (data) => {
      stdout += data.toString();
      const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
      const codeMatch = stdout.match(/code[:\s]+([A-Z0-9-]+)/i);
      if (urlMatch && codeMatch && !infoFound) {
        infoFound = true;
        resolve({ process: proc, url: urlMatch[1], code: codeMatch[1] });
      }
    });

    proc.on("error", (err) => {
      if (!infoFound) reject(err);
    });

    proc.on("close", (code) => {
      if (!infoFound) {
        reject(new Error(`codex login exited with code ${code}. Output: ${stdout}`));
      }
    });

    setTimeout(() => {
      if (!infoFound) {
        proc.kill();
        reject(new Error(`Timed out waiting for device code. Output so far: ${stdout}`));
      }
    }, 30_000);
  });
}

// Wait for claude setup-token to complete after user pastes code
function waitForClaudeToken(proc) {
  return new Promise((resolve, reject) => {
    let stdout = "";

    const onData = (data) => {
      stdout += data.toString();
      // Look for token pattern
      const tokenMatch = stdout.match(/(sk-ant-oat01-[^\s]+)/);
      if (tokenMatch) {
        cleanup();
        resolve(tokenMatch[1]);
      }
    };

    const cleanup = () => {
      proc.stdout.removeListener("data", onData);
      proc.stderr.removeListener("data", onData);
    };

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("close", (code) => {
      if (code === 0) {
        // Process completed successfully — token may have been saved directly
        resolve(null);
      } else {
        reject(new Error(`claude setup-token exited with code ${code}. Output: ${stdout}`));
      }
    });

    setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for token"));
    }, AUTH_TIMEOUT_MS);
  });
}

// Wait for codex device auth to complete (it polls automatically)
function waitForCodexAuth(proc) {
  return new Promise((resolve, reject) => {
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(`codex login exited with code ${code}`));
      }
    });

    setTimeout(() => {
      proc.kill();
      reject(new Error("Timed out waiting for device auth"));
    }, AUTH_TIMEOUT_MS);
  });
}

// ── Auth flow with API key paste fallback ──────────────────────────
async function pasteApiKey(provider, apiKey) {
  return new Promise((resolve, reject) => {
    const proc = spawn("openclaw", [
      "models",
      "auth",
      "paste-token",
      "--provider",
      providerKey(provider),
    ], { stdio: ["pipe", "pipe", "pipe"] });

    proc.stdin.write(apiKey + "\n");
    proc.stdin.end();

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`paste-token exited with code ${code}`));
    });

    proc.on("error", reject);
  });
}

async function restartGateway() {
  return new Promise((resolve, reject) => {
    const proc = spawn("openclaw", ["gateway", "restart"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gateway restart exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function updateConfigForProvider(provider, isFirst) {
  const config = await readOpenClawConfig();

  const model = modelId(provider);

  if (isFirst) {
    config.models.primaryModel = model;
  } else {
    if (!config.models.alternativeModels) {
      config.models.alternativeModels = [];
    }
    if (!config.models.alternativeModels.includes(model)) {
      config.models.alternativeModels.push(model);
    }
  }

  await writeOpenClawConfig(config);
}

async function finalizeConfig() {
  const config = await readOpenClawConfig();

  // Remove claw-free provider
  if (config.models?.providers?.["claw-free"]) {
    delete config.models.providers["claw-free"];
  }

  await writeOpenClawConfig(config);
  await restartGateway();
}

// ── Stage handlers ─────────────────────────────────────────────────
async function handleWelcome() {
  const provider = state.selectedProvider;
  const displayName = providerDisplayName(provider);

  try {
    if (provider === "claude") {
      const result = await spawnClaudeAuth();
      state.childProcess = result.process;
      state.capturedUrl = result.url;
      state.stage = "waiting_for_code";

      // Set timeout for entire auth
      state.authTimer = setTimeout(() => {
        killAuthProcess();
        state.stage = "api_key_fallback";
      }, AUTH_TIMEOUT_MS);

      return `Welcome to claw.free! Let's set up ${displayName}.

Click this link to authenticate:
${result.url}

After you log in, you'll get a code. Paste it here.`;
    } else {
      // OpenAI / Codex
      const result = await spawnCodexAuth();
      state.childProcess = result.process;
      state.capturedCode = result.code;
      state.stage = "waiting_for_device_auth";

      // Codex polls automatically — wait in background
      waitForCodexAuth(result.process)
        .then(async () => {
          state.configuredProviders.push("openai");
          await updateConfigForProvider("openai", state.configuredProviders.length === 1);
          state.childProcess = null;
          state.stage = "auth_complete";
        })
        .catch(() => {
          state.stage = "api_key_fallback";
          state.childProcess = null;
        });

      state.authTimer = setTimeout(() => {
        killAuthProcess();
        state.stage = "api_key_fallback";
      }, AUTH_TIMEOUT_MS);

      return `Welcome to claw.free! Let's set up ${displayName}.

Go to: ${result.url}
Enter this code: **${result.code}**

I'll detect when you're done automatically. Just send any message after you've authorized.`;
    }
  } catch (err) {
    // Auth process failed to start — fall back to API key
    state.stage = "api_key_fallback";
    return getApiKeyFallbackMessage(provider);
  }
}

function getApiKeyFallbackMessage(provider) {
  if (provider === "claude") {
    return `I wasn't able to start the automatic login flow. No worries — you can paste an API key instead.

1. Go to https://console.anthropic.com/settings/keys
2. Create a new key
3. Paste it here`;
  }
  return `I wasn't able to start the automatic login flow. No worries — you can paste an API key instead.

1. Go to https://platform.openai.com/api-keys
2. Create a new key
3. Paste it here`;
}

async function handleWaitingForCode(userMessage) {
  const code = userMessage.trim();

  if (!state.childProcess) {
    state.stage = "api_key_fallback";
    return getApiKeyFallbackMessage(state.selectedProvider);
  }

  try {
    // Write code to claude's stdin
    state.childProcess.stdin.write(code + "\n");

    const token = await waitForClaudeToken(state.childProcess);
    killAuthProcess();

    // If token was captured, paste it
    if (token) {
      await pasteApiKey("claude", token);
    }

    state.configuredProviders.push("claude");
    await updateConfigForProvider("claude", state.configuredProviders.length === 1);

    return promptAddAnother("claude");
  } catch (err) {
    killAuthProcess();
    state.stage = "api_key_fallback";
    return `That didn't work (${err.message}). Let's try the API key method instead.

${getApiKeyFallbackMessage(state.selectedProvider)}`;
  }
}

async function handleWaitingForDeviceAuth(userMessage) {
  // Codex polls automatically. Check if auth completed.
  if (state.stage === "auth_complete") {
    return promptAddAnother("openai");
  }

  if (state.stage === "api_key_fallback") {
    return getApiKeyFallbackMessage("openai");
  }

  // Still waiting
  return "Still waiting for you to authorize. Go to the link above and enter the code. Send another message when you're done.";
}

async function handleApiKeyFallback(userMessage) {
  const apiKey = userMessage.trim();
  const provider = state.selectedProvider;

  // Basic validation
  if (provider === "claude" && !apiKey.startsWith("sk-ant-")) {
    return "That doesn't look like a Claude API key (should start with sk-ant-). Try again:";
  }
  if (provider === "openai" && !apiKey.startsWith("sk-")) {
    return "That doesn't look like an OpenAI API key (should start with sk-). Try again:";
  }

  try {
    await pasteApiKey(provider, apiKey);
    state.configuredProviders.push(provider);
    await updateConfigForProvider(provider, state.configuredProviders.length === 1);

    return promptAddAnother(provider);
  } catch (err) {
    return `Failed to save the API key: ${err.message}. Try pasting it again:`;
  }
}

function promptAddAnother(justConfigured) {
  const other = otherProvider(justConfigured);
  const otherName = providerDisplayName(other);
  const justName = providerDisplayName(justConfigured);

  state.stage = "add_another";

  return `${justName} is set up as your ${state.configuredProviders.length === 1 ? "primary" : "alternative"} model!

Would you like to also add ${otherName} as an alternative?
1. Yes, add ${otherName}
2. No, start chatting!

Reply with 1 or 2.`;
}

async function handleAddAnother(userMessage) {
  const choice = userMessage.trim();

  if (choice === "1" || choice.toLowerCase().startsWith("yes")) {
    // Switch to other provider and start auth
    state.selectedProvider = otherProvider(state.selectedProvider);
    state.stage = "welcome";
    return handleWelcome();
  }

  // User chose to start chatting
  return finishSetup();
}

async function finishSetup() {
  state.stage = "done";
  try {
    await finalizeConfig();
  } catch (err) {
    return `Setup is done but I had trouble restarting: ${err.message}. Try messaging again in a few seconds.`;
  }

  return "All set! Your bot is restarting now with the real AI model. Send any message in a few seconds to start chatting!";
}

async function handleDone() {
  return "Setup is already complete. Your bot should be using the real AI model now. If it's not responding, wait a few seconds and try again.";
}

// ── Message router ─────────────────────────────────────────────────
async function handleMessage(userMessage) {
  // Check if device auth completed in background (codex)
  if (state.stage === "waiting_for_device_auth") {
    // Re-check — stage may have been updated by the background promise
    if (state.configuredProviders.includes("openai")) {
      return promptAddAnother("openai");
    }
    if (state.stage === "api_key_fallback") {
      return getApiKeyFallbackMessage("openai");
    }
  }

  switch (state.stage) {
    case "welcome":
      return handleWelcome();
    case "waiting_for_code":
      return handleWaitingForCode(userMessage);
    case "waiting_for_device_auth":
      return handleWaitingForDeviceAuth(userMessage);
    case "auth_complete":
      return promptAddAnother(state.selectedProvider);
    case "api_key_fallback":
      return handleApiKeyFallback(userMessage);
    case "add_another":
      return handleAddAnother(userMessage);
    case "done":
      return handleDone();
    default:
      return "Something went wrong. Send /start to restart.";
  }
}

// ── HTTP Server (OpenAI-compatible) ────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function chatResponse(content) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "claw-free/setup",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", stage: state.stage }));
    return;
  }

  // Models endpoint
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: "setup",
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "claw-free",
          },
        ],
      })
    );
    return;
  }

  // Chat completions
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    try {
      const body = await parseBody(req);
      const messages = body.messages || [];
      const lastUserMsg =
        messages.filter((m) => m.role === "user").pop()?.content || "";

      const reply = await handleMessage(lastUserMsg);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(chatResponse(reply)));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          chatResponse(`Internal error: ${err.message}. Send any message to retry.`)
        )
      );
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`claw-free-provider listening on port ${PORT}`);
  console.log(`Stage: ${state.stage}`);
  console.log(`LLM provider: ${state.selectedProvider}`);
});

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const PORT = parseInt(process.env.PORT, 10) || 3456;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || "/var/lib/openclaw/home/.openclaw/openclaw.json";
const CLAW_FREE_MODEL = "claw-free/setup";
const SUPPORTED_PROVIDERS = ["claude", "openai", "kimi"];
const PROVIDER_CONFIG = {
  claude: {
    displayName: "Claude (Anthropic)",
    model: "anthropic/claude-sonnet-4-20250514",
    authKey: "anthropic",
    apiKeyPrefix: "sk-ant-",
    apiKeyHelp: [
      "1. Go to https://console.anthropic.com/settings/keys",
      "2. Create a new key",
      "3. Paste it here",
    ],
  },
  openai: {
    displayName: "ChatGPT (OpenAI)",
    model: "openai/gpt-4o",
    authKey: "openai",
    apiKeyPrefix: "sk-",
    apiKeyHelp: [
      "1. Go to https://platform.openai.com/api-keys",
      "2. Create a new key",
      "3. Paste it here",
    ],
  },
  kimi: {
    displayName: "Kimi Coding",
    model: "kimi-coding/k2p5",
    authKey: "kimi-coding",
    apiKeyPrefix: "sk-",
    apiKeyHelp: [
      "1. Go to https://www.kimi.com/code/en",
      "2. Create a Kimi Coding API key",
      "3. Paste it here",
    ],
  },
};
const CLAW_FREE_PROVIDER_CONFIG = {
  baseUrl: "http://localhost:3456/v1",
  apiKey: "local",
  api: "openai-completions",
  models: [
    {
      id: "setup",
      name: "claw.free Setup",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
  ],
};

// ── State ──────────────────────────────────────────────────────────
const state = {
  stage: "welcome", // welcome | waiting_for_code | waiting_for_device_auth | auth_complete | api_key_fallback | add_another | management | done
  selectedProvider: normalizeProvider(process.env.LLM_PROVIDER || "claude"),
  childProcess: null,
  authTimer: null,
  configuredProviders: [],
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
  return PROVIDER_CONFIG[provider]?.displayName ?? PROVIDER_CONFIG.claude.displayName;
}

function normalizeProvider(provider) {
  return SUPPORTED_PROVIDERS.includes(provider) ? provider : "claude";
}

function modelId(provider) {
  return PROVIDER_CONFIG[provider]?.model ?? PROVIDER_CONFIG.claude.model;
}

function providerKey(provider) {
  return PROVIDER_CONFIG[provider]?.authKey ?? PROVIDER_CONFIG.claude.authKey;
}

function apiKeyPrefix(provider) {
  return PROVIDER_CONFIG[provider]?.apiKeyPrefix ?? "sk-";
}

function getRemainingProviders() {
  return SUPPORTED_PROVIDERS.filter(
    (provider) => !state.configuredProviders.includes(provider),
  );
}

// ── State sync from config file ────────────────────────────────────
async function syncStateFromConfig() {
  try {
    const config = await readOpenClawConfig();
    const providers = config?.models?.providers ?? {};

    // Derive configuredProviders from what's already in the config
    const configured = [];
    for (const provider of SUPPORTED_PROVIDERS) {
      const key = providerKey(provider);
      if (providers[key]) {
        configured.push(provider);
      }
    }
    state.configuredProviders = configured;

    // Check if claw-free/setup is the primary model — if so, we're in an
    // active setup/auth flow (e.g. switch-llm.sh was used), not management.
    const primaryModel = config?.agents?.defaults?.model?.primary;
    const isSetupActive = primaryModel === CLAW_FREE_MODEL;

    if (configured.length > 0 && providers["claw-free"] && !isSetupActive) {
      // Real providers configured + claw-free as fallback → management mode
      state.stage = "management";
    } else if (!providers["claw-free"]) {
      // Legacy: claw-free was removed (old finalizeConfig behavior)
      state.stage = "done";
    }
    // Otherwise: claw-free is primary (setup flow active) — keep current stage
  } catch {
    // Config file doesn't exist or is unreadable — fresh start, keep defaults
  }
}

// ── Stage marker encoding/parsing ──────────────────────────────────
function stageMarker(stage, provider) {
  return `\n\n<!---setup:${stage}:${provider}-->`;
}

function parseStageMarker(messages) {
  // Find the last assistant message and extract the marker
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && typeof msg.content === "string") {
      const match = msg.content.match(/<!---setup:([^:]+):(\w+)-->/);
      if (match) {
        return { stage: match[1], provider: match[2] };
      }
      break; // only check the last assistant message
    }
  }
  return null;
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

function ensureConfigShape(config) {
  if (!config.gateway || typeof config.gateway !== "object") config.gateway = {};
  if (!config.agents || typeof config.agents !== "object") config.agents = {};
  if (!config.agents.defaults || typeof config.agents.defaults !== "object") {
    config.agents.defaults = {};
  }
  if (
    !config.agents.defaults.model ||
    typeof config.agents.defaults.model !== "object"
  ) {
    config.agents.defaults.model = {};
  }
  if (!config.models || typeof config.models !== "object") config.models = {};
  if (!config.models.providers || typeof config.models.providers !== "object") {
    config.models.providers = {};
  }
  if (!config.models.mode) {
    config.models.mode = "merge";
  }

  // Keep gateway bootable in strict mode.
  if (!config.gateway.mode) {
    config.gateway.mode = "local";
  }
  if (!config.agents.defaults.model.primary) {
    config.agents.defaults.model.primary = CLAW_FREE_MODEL;
  }
  if (!config.models.providers["claw-free"]) {
    config.models.providers["claw-free"] = JSON.parse(
      JSON.stringify(CLAW_FREE_PROVIDER_CONFIG),
    );
  }
}

function migrateLegacyModelKeys(config) {
  const legacyPrimary = config?.models?.primaryModel;
  if (
    typeof legacyPrimary === "string" &&
    !config?.agents?.defaults?.model?.primary
  ) {
    ensureConfigShape(config);
    config.agents.defaults.model.primary = legacyPrimary;
  }

  const legacyAlternatives = config?.models?.alternativeModels;
  if (
    Array.isArray(legacyAlternatives) &&
    legacyAlternatives.length > 0 &&
    !Array.isArray(config?.agents?.defaults?.model?.fallbacks)
  ) {
    ensureConfigShape(config);
    config.agents.defaults.model.fallbacks = legacyAlternatives.slice();
  }

  if (config?.models && typeof config.models === "object") {
    delete config.models.primaryModel;
    delete config.models.alternativeModels;
  }
}

function addFallbackModel(config, model) {
  ensureConfigShape(config);
  const primary = config.agents.defaults.model.primary;
  const current = Array.isArray(config.agents.defaults.model.fallbacks)
    ? config.agents.defaults.model.fallbacks
    : [];

  const deduped = current.filter(
    (candidate) => typeof candidate === "string" && candidate !== model && candidate !== primary,
  );
  if (model !== primary && !deduped.includes(model)) {
    deduped.push(model);
  }
  config.agents.defaults.model.fallbacks = deduped;
}

async function updateConfigForProvider(provider, isFirst) {
  const config = await readOpenClawConfig();
  migrateLegacyModelKeys(config);
  ensureConfigShape(config);

  const model = modelId(provider);
  if (isFirst) {
    config.agents.defaults.model.primary = model;
  } else {
    addFallbackModel(config, model);
  }

  await writeOpenClawConfig(config);
}

async function finalizeConfig() {
  const config = await readOpenClawConfig();
  migrateLegacyModelKeys(config);
  ensureConfigShape(config);

  // Keep claw-free provider in config as a fallback for management operations.
  // Remove it from the fallback model list so it doesn't interfere with normal chat.
  if (Array.isArray(config.agents.defaults.model.fallbacks)) {
    config.agents.defaults.model.fallbacks = config.agents.defaults.model.fallbacks.filter(
      (model) => model !== CLAW_FREE_MODEL,
    );
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
      state.stage = "waiting_for_code";

      // Set timeout for entire auth
      state.authTimer = setTimeout(() => {
        killAuthProcess();
        state.stage = "api_key_fallback";
      }, AUTH_TIMEOUT_MS);

      return `Welcome to claw.free! Let's set up ${displayName}.

Click this link to authenticate:
${result.url}

After you log in, you'll get a code. Paste it here.${stageMarker("waiting_for_code", provider)}`;
    }

    if (provider === "openai") {
      const result = await spawnCodexAuth();
      state.childProcess = result.process;
      state.stage = "waiting_for_device_auth";

      // Codex polls automatically — wait in background
      waitForCodexAuth(result.process)
        .then(async () => {
          if (!state.configuredProviders.includes("openai")) {
            state.configuredProviders.push("openai");
          }
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

I'll detect when you're done automatically. Just send any message after you've authorized.${stageMarker("waiting_for_device_auth", provider)}`;
    }

    state.stage = "api_key_fallback";
    return `Welcome to claw.free! Let's set up ${displayName}.

${getApiKeyFallbackMessage(provider, false)}${stageMarker("api_key_fallback", provider)}`;
  } catch (err) {
    // Auth process failed to start — fall back to API key
    state.stage = "api_key_fallback";
    return `${getApiKeyFallbackMessage(provider)}${stageMarker("api_key_fallback", provider)}`;
  }
}

function getApiKeyFallbackMessage(provider, includePreface = true) {
  const config = PROVIDER_CONFIG[provider] ?? PROVIDER_CONFIG.claude;
  const preface = includePreface
    ? "I wasn't able to start the automatic login flow. No worries — you can paste an API key instead.\n\n"
    : "";
  return `${preface}${config.apiKeyHelp.join("\n")}`;
}

async function handleWaitingForCode(userMessage) {
  const code = userMessage.trim();

  if (!state.childProcess) {
    // Instance restarted — re-spawn auth process
    try {
      const result = await spawnClaudeAuth();
      state.childProcess = result.process;
      state.authTimer = setTimeout(() => {
        killAuthProcess();
        state.stage = "api_key_fallback";
      }, AUTH_TIMEOUT_MS);

      return `Your previous session expired. Here's a new link:
${result.url}

After you log in, paste the code here.${stageMarker("waiting_for_code", state.selectedProvider)}`;
    } catch (err) {
      state.stage = "api_key_fallback";
      return `${getApiKeyFallbackMessage(state.selectedProvider)}${stageMarker("api_key_fallback", state.selectedProvider)}`;
    }
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

    if (!state.configuredProviders.includes("claude")) {
      state.configuredProviders.push("claude");
    }
    await updateConfigForProvider("claude", state.configuredProviders.length === 1);

    return promptAddAnother("claude");
  } catch (err) {
    killAuthProcess();
    state.stage = "api_key_fallback";
    return `That didn't work (${err.message}). Let's try the API key method instead.

${getApiKeyFallbackMessage(state.selectedProvider)}${stageMarker("api_key_fallback", state.selectedProvider)}`;
  }
}

async function handleWaitingForDeviceAuth(userMessage) {
  // Codex polls automatically. Check if auth completed.
  if (state.stage === "auth_complete") {
    return promptAddAnother("openai");
  }

  if (state.stage === "api_key_fallback") {
    return `${getApiKeyFallbackMessage("openai")}${stageMarker("api_key_fallback", "openai")}`;
  }

  if (!state.childProcess) {
    // Instance restarted — re-spawn device auth
    try {
      const result = await spawnCodexAuth();
      state.childProcess = result.process;

      waitForCodexAuth(result.process)
        .then(async () => {
          if (!state.configuredProviders.includes("openai")) {
            state.configuredProviders.push("openai");
          }
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

      return `Your previous session expired. Here's a new code:

Go to: ${result.url}
Enter this code: **${result.code}**

Send another message after you've authorized.${stageMarker("waiting_for_device_auth", "openai")}`;
    } catch (err) {
      state.stage = "api_key_fallback";
      return `${getApiKeyFallbackMessage("openai")}${stageMarker("api_key_fallback", "openai")}`;
    }
  }

  // Still waiting
  return `Still waiting for you to authorize. Go to the link above and enter the code. Send another message when you're done.${stageMarker("waiting_for_device_auth", state.selectedProvider)}`;
}

async function handleApiKeyFallback(userMessage) {
  const apiKey = userMessage.trim();
  const provider = state.selectedProvider;

  // Basic validation
  const expectedPrefix = apiKeyPrefix(provider);
  if (!apiKey.startsWith(expectedPrefix)) {
    return `That doesn't look like a ${providerDisplayName(provider)} API key (should start with ${expectedPrefix}). Try again:${stageMarker("api_key_fallback", provider)}`;
  }

  try {
    await pasteApiKey(provider, apiKey);
    if (!state.configuredProviders.includes(provider)) {
      state.configuredProviders.push(provider);
    }
    await updateConfigForProvider(provider, state.configuredProviders.length === 1);

    return promptAddAnother(provider);
  } catch (err) {
    return `Failed to save the API key: ${err.message}. Try pasting it again:${stageMarker("api_key_fallback", provider)}`;
  }
}

function promptAddAnother(justConfigured) {
  const justName = providerDisplayName(justConfigured);
  const remaining = getRemainingProviders();

  if (remaining.length === 0) {
    return finishSetup();
  }

  state.stage = "add_another";
  const options = remaining
    .map((provider, idx) => `${idx + 1}. Add ${providerDisplayName(provider)}`)
    .join("\n");
  const finishOption = `${remaining.length + 1}. No, start chatting!`;

  return `${justName} is set up as your ${state.configuredProviders.length === 1 ? "primary" : "alternative"} model!

Would you like to add another provider as an alternative?
${options}
${finishOption}

Reply with a number.${stageMarker("add_another", justConfigured)}`;
}

async function handleAddAnother(userMessage) {
  const choice = userMessage.trim().toLowerCase();
  const remaining = getRemainingProviders();
  const finishChoice = String(remaining.length + 1);

  if (
    choice === finishChoice ||
    choice === "0" ||
    choice.startsWith("no") ||
    choice === "skip" ||
    choice === "done"
  ) {
    return finishSetup();
  }

  if (/^\d+$/.test(choice)) {
    const selected = remaining[Number(choice) - 1];
    if (!selected) {
      return `Please reply with a number between 1 and ${remaining.length + 1}.${stageMarker("add_another", state.selectedProvider)}`;
    }

    state.selectedProvider = selected;
    state.stage = "welcome";
    return handleWelcome();
  }

  const selectedByName = remaining.find((provider) => {
    const display = providerDisplayName(provider).toLowerCase();
    return choice.includes(provider) || choice.includes(display);
  });
  if (selectedByName) {
    state.selectedProvider = selectedByName;
    state.stage = "welcome";
    return handleWelcome();
  }

  return `Please reply with a number between 1 and ${remaining.length + 1}.${stageMarker("add_another", state.selectedProvider)}`;
}

async function finishSetup() {
  state.stage = "management";
  try {
    await finalizeConfig();
  } catch (err) {
    return `Setup is done but I had trouble restarting: ${err.message}. Try messaging again in a few seconds.${stageMarker("management", state.selectedProvider)}`;
  }

  return `All set! Your bot is restarting now with the real AI model. Send any message in a few seconds to start chatting!

You can always add more AI providers later — just ask your bot to "add a model".${stageMarker("management", state.selectedProvider)}`;
}

async function handleManagement(userMessage) {
  const msg = userMessage.trim().toLowerCase();

  // "add model" / "add provider" → re-enter setup flow for a new provider
  if (msg.includes("add") && (msg.includes("model") || msg.includes("provider"))) {
    const remaining = getRemainingProviders();
    if (remaining.length === 0) {
      return `All supported providers are already configured (${state.configuredProviders.map(providerDisplayName).join(", ")}).${stageMarker("management", state.selectedProvider)}`;
    }

    const options = remaining
      .map((provider, idx) => `${idx + 1}. ${providerDisplayName(provider)}`)
      .join("\n");

    state.stage = "add_another";
    return `Which provider would you like to add?\n${options}\n\nReply with a number.${stageMarker("add_another", state.selectedProvider)}`;
  }

  // "list models" / "show models" → display configured providers
  if ((msg.includes("list") || msg.includes("show")) && (msg.includes("model") || msg.includes("provider"))) {
    return listModelsMessage();
  }

  // "remove model" / "remove provider" → explain how
  if (msg.includes("remove") && (msg.includes("model") || msg.includes("provider"))) {
    return `To remove a provider, ask your bot to run the management skill status command. Model removal requires editing the config directly for now.${stageMarker("management", state.selectedProvider)}`;
  }

  // Default: brief help
  return `This is the claw.free management interface. Your configured models:\n${listModelsBody()}\n\nYou can say:\n- "add model" to add another AI provider\n- "list models" to see configured providers${stageMarker("management", state.selectedProvider)}`;
}

function listModelsBody() {
  if (state.configuredProviders.length === 0) {
    return "  (none configured)";
  }
  return state.configuredProviders
    .map((p, idx) => {
      const label = idx === 0 ? "(primary)" : "(fallback)";
      return `  ${providerDisplayName(p)} ${label}`;
    })
    .join("\n");
}

function listModelsMessage() {
  return `Configured providers:\n${listModelsBody()}\n\nRemaining: ${getRemainingProviders().map(providerDisplayName).join(", ") || "none"}\n\nSay "add model" to add another provider.${stageMarker("management", state.selectedProvider)}`;
}

async function handleDone() {
  // Legacy: reached when claw-free was removed from config.
  // In that case this provider is no longer reachable from normal chat,
  // so just return a terminal "done" response.
  return `Setup is already complete. Your bot should be using the real AI model now. If it's not responding, wait a few seconds and try again.${stageMarker("done", state.selectedProvider)}`;
}

// ── Message router ─────────────────────────────────────────────────
async function handleMessage(userMessage, messages) {
  // Reconstruct state from config file (survives restarts)
  await syncStateFromConfig();

  // If setup already complete (detected from config), short-circuit
  if (state.stage === "done") {
    return handleDone();
  }

  // Reconstruct stage and selectedProvider from last assistant message marker
  const marker = parseStageMarker(messages);
  if (marker) {
    state.stage = marker.stage;
    state.selectedProvider = normalizeProvider(marker.provider);
  }

  // Check if device auth completed in background (codex)
  if (state.stage === "waiting_for_device_auth") {
    // Re-check — stage may have been updated by the background promise
    if (state.configuredProviders.includes("openai")) {
      return promptAddAnother("openai");
    }
    if (state.stage === "api_key_fallback") {
      return `${getApiKeyFallbackMessage("openai")}${stageMarker("api_key_fallback", "openai")}`;
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
    case "management":
      return handleManagement(userMessage);
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

      const reply = await handleMessage(lastUserMsg, messages);

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

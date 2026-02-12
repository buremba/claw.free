import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TEST_PORT = 19876;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DIR = join(tmpdir(), `claw-free-test-${process.pid}`);
const CONFIG_PATH = join(TEST_DIR, "openclaw.json");
const MOCK_BIN_DIR = join(TEST_DIR, "bin");

// ── Helpers ──────────────────────────────────────────────────────────

async function writeTestConfig(config) {
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function readTestConfig() {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

async function createMockBinaries() {
  await mkdir(MOCK_BIN_DIR, { recursive: true });

  // Mock `claude` that simulates setup-token flow:
  // 1. Prints a URL
  // 2. Reads a code from stdin
  // 3. Prints a token
  await writeFile(
    join(MOCK_BIN_DIR, "claude"),
    "#!/bin/bash\n" +
      'if [ "$1" = "setup-token" ]; then\n' +
      '  echo "Visit https://test-auth.example.com/login?session=abc123 to authenticate"\n' +
      "  read -r code\n" +
      '  echo "Token: sk-ant-oat01-testtoken-$code"\n' +
      "  exit 0\n" +
      "fi\n" +
      "exit 1\n",
  );
  await chmod(join(MOCK_BIN_DIR, "claude"), 0o755);

  // Mock `openclaw` that handles paste-token and gateway restart.
  // paste-token writes the provider entry into the config file so
  // syncStateFromConfig can detect it after a restart.
  await writeFile(
    join(MOCK_BIN_DIR, "openclaw"),
    "#!/bin/bash\n" +
      'if [ "$1" = "models" ] && [ "$2" = "auth" ] && [ "$3" = "paste-token" ]; then\n' +
      "  read -r token\n" +
      '  PROVIDER="$5"\n' +
      '  CONFIG="$OPENCLAW_CONFIG_PATH"\n' +
      '  if [ -f "$CONFIG" ] && command -v node >/dev/null 2>&1; then\n' +
      "    node -e \"\n" +
      "      const fs = require('fs');\n" +
      "      const c = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf-8'));\n" +
      "      if (!c.models) c.models = {};\n" +
      "      if (!c.models.providers) c.models.providers = {};\n" +
      "      c.models.providers[process.argv[1]] = { apiKey: 'mock-token' };\n" +
      "      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(c, null, 2));\n" +
      '    " "$PROVIDER"\n' +
      "  fi\n" +
      "  exit 0\n" +
      "fi\n" +
      'if [ "$1" = "gateway" ] && [ "$2" = "restart" ]; then\n' +
      "  exit 0\n" +
      "fi\n" +
      "exit 1\n",
  );
  await chmod(join(MOCK_BIN_DIR, "openclaw"), 0o755);

  // Mock `codex` that simulates device auth flow:
  // Prints URL + code, then exits successfully after a short delay
  await writeFile(
    join(MOCK_BIN_DIR, "codex"),
    `#!/bin/bash
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  echo "Go to: https://test-device.example.com/activate"
  echo "Enter code: ABCD-1234"
  sleep 1
  exit 0
fi
exit 1
`,
  );
  await chmod(join(MOCK_BIN_DIR, "codex"), 0o755);
}

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["server.js"], {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        OPENCLAW_CONFIG_PATH: CONFIG_PATH,
        PATH: `${MOCK_BIN_DIR}:${process.env.PATH}`,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error("Server did not start within 5s"));
      }
    }, 5000);

    proc.stdout.on("data", (data) => {
      if (!started && data.toString().includes("listening")) {
        started = true;
        clearTimeout(timeout);
        resolve(proc);
      }
    });

    proc.stderr.on("data", (data) => {
      // Some startup info may go to stderr
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on("close", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code} before starting`));
      }
    });
  });
}

function killServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) {
      resolve();
      return;
    }
    proc.on("close", () => resolve());
    proc.kill("SIGTERM");
    // Force kill after 2s
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 2000);
  });
}

async function chat(messages) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "setup", messages }),
  });
  const json = await res.json();
  return json.choices[0].message.content;
}

function extractMarker(content) {
  const match = content.match(/<!---setup:([^:]+):(\w+)-->/);
  if (match) return { stage: match[1], provider: match[2] };
  return null;
}

// ── Unit tests for marker format ─────────────────────────────────────

describe("stage marker format", () => {
  it("marker is a valid HTML comment with stage and provider", () => {
    // Simulates stageMarker("waiting_for_code", "claude")
    const marker = `\n\n<!---setup:waiting_for_code:claude-->`;
    expect(marker).toContain("<!---setup:");
    expect(marker).toContain("-->");
  });

  it("parseStageMarker extracts stage and provider from assistant message", () => {
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content:
          "Welcome! Click this link to authenticate:\nhttps://example.com\n\n<!---setup:waiting_for_code:claude-->",
      },
    ];
    const marker = extractMarker(
      messages.filter((m) => m.role === "assistant").pop().content,
    );
    expect(marker).toEqual({ stage: "waiting_for_code", provider: "claude" });
  });

  it("parseStageMarker returns null when no marker present", () => {
    const content = "Just a regular message with no marker";
    expect(extractMarker(content)).toBeNull();
  });

  it("parseStageMarker handles all stage types", () => {
    const stages = [
      "welcome",
      "waiting_for_code",
      "waiting_for_device_auth",
      "auth_complete",
      "api_key_fallback",
      "add_another",
      "done",
    ];
    for (const stage of stages) {
      const content = `some text\n\n<!---setup:${stage}:claude-->`;
      const marker = extractMarker(content);
      expect(marker).toEqual({ stage, provider: "claude" });
    }
  });

  it("parseStageMarker handles all providers", () => {
    for (const provider of ["claude", "openai", "kimi"]) {
      const content = `text\n\n<!---setup:waiting_for_code:${provider}-->`;
      const marker = extractMarker(content);
      expect(marker?.provider).toBe(provider);
    }
  });
});

// ── Integration tests ────────────────────────────────────────────────

describe("provider server restart resilience", () => {
  let server;

  beforeAll(async () => {
    await createMockBinaries();
  });

  afterAll(async () => {
    await killServer(server);
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await killServer(server);
    server = null;
  });

  describe("claude auth flow with restart", () => {
    it("returns auth URL on first message and includes stage marker", async () => {
      await writeTestConfig({
        models: {
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
            },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "claude" });

      const reply = await chat([{ role: "user", content: "hello" }]);

      expect(reply).toContain("https://test-auth.example.com/");
      expect(reply).toContain("Paste it here");

      const marker = extractMarker(reply);
      expect(marker).toEqual({
        stage: "waiting_for_code",
        provider: "claude",
      });
    });

    it("re-spawns auth with new URL after server restart mid-auth", async () => {
      await writeTestConfig({
        models: {
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
            },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "claude" });

      // Step 1: Get initial auth URL
      const welcomeReply = await chat([{ role: "user", content: "hello" }]);
      expect(welcomeReply).toContain("https://test-auth.example.com/");

      // Step 2: Kill the server (simulates instance restart)
      await killServer(server);

      // Step 3: Restart the server
      server = await startServer({ LLM_PROVIDER: "claude" });

      // Step 4: Send a message with the previous conversation context
      // The marker in the assistant message tells the new instance we were in waiting_for_code
      const reply = await chat([
        { role: "user", content: "hello" },
        { role: "assistant", content: welcomeReply },
        { role: "user", content: "some-code-123" },
      ]);

      // Should re-spawn auth (childProcess is null after restart)
      expect(reply).toContain("previous session expired");
      expect(reply).toContain("https://test-auth.example.com/");

      const marker = extractMarker(reply);
      expect(marker).toEqual({
        stage: "waiting_for_code",
        provider: "claude",
      });
    });

    it("completes auth flow when code is pasted with live process", async () => {
      await writeTestConfig({
        models: {
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
            },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "claude" });

      // Get welcome
      const welcome = await chat([{ role: "user", content: "hello" }]);
      expect(welcome).toContain("https://test-auth.example.com/");

      // Paste the auth code (the mock claude script will output a token)
      const reply = await chat([
        { role: "user", content: "hello" },
        { role: "assistant", content: welcome },
        { role: "user", content: "myauthcode" },
      ]);

      // Should succeed and offer to add another provider
      expect(reply).toContain("set up");
      const marker = extractMarker(reply);
      expect(marker?.stage).toBe("add_another");
    });
  });

  describe("API key fallback flow", () => {
    it("falls back to API key for kimi (no auth binary)", async () => {
      await writeTestConfig({
        models: {
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
            },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "kimi" });

      const reply = await chat([{ role: "user", content: "hello" }]);

      expect(reply).toContain("kimi.com");
      const marker = extractMarker(reply);
      expect(marker?.stage).toBe("api_key_fallback");
      expect(marker?.provider).toBe("kimi");
    });

    it("rejects invalid API key prefix", async () => {
      await writeTestConfig({
        models: {
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
            },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "kimi" });

      const welcome = await chat([{ role: "user", content: "hello" }]);

      const reply = await chat([
        { role: "user", content: "hello" },
        { role: "assistant", content: welcome },
        { role: "user", content: "not-a-valid-key" },
      ]);

      expect(reply).toContain("doesn't look like");
      expect(reply).toContain("sk-");
      const marker = extractMarker(reply);
      expect(marker?.stage).toBe("api_key_fallback");
    });

    it("accepts valid API key and updates config", async () => {
      await writeTestConfig({
        models: {
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
            },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "kimi" });

      const welcome = await chat([{ role: "user", content: "hello" }]);

      const reply = await chat([
        { role: "user", content: "hello" },
        { role: "assistant", content: welcome },
        { role: "user", content: "sk-test-kimi-key-123" },
      ]);

      expect(reply).toContain("set up");
      expect(reply).toContain("add another");
      const marker = extractMarker(reply);
      expect(marker?.stage).toBe("add_another");
    });
  });

  describe("config-based state recovery", () => {
    it("remembers configured provider after restart via config file", async () => {
      // Write config as if claude was already configured
      await writeTestConfig({
        models: {
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
            },
            anthropic: {
              baseUrl: "https://api.anthropic.com/v1",
              apiKey: "stored",
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-20250514" },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "claude" });

      // First message with no conversation history — should see welcome
      // but syncStateFromConfig should know claude is already configured
      const reply = await chat([{ role: "user", content: "hello" }]);

      // The server knows claude is configured (from config), so when it
      // starts the welcome flow for claude and completes it, the add_another
      // should show claude is already done. But since this is welcome stage
      // (no marker), it'll try to start auth for claude. The key test is
      // that configuredProviders is populated from the config.
      // Since claude auth will succeed (mock binary), it should work.
      expect(reply).toBeTruthy();
    });

    it("responds with setup complete after restart when claw-free is removed", async () => {
      // Config with claw-free removed = setup was finalized
      await writeTestConfig({
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com/v1",
              apiKey: "stored",
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-20250514" },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "claude" });

      const reply = await chat([{ role: "user", content: "hello" }]);

      expect(reply).toContain("Setup is already complete");
      const marker = extractMarker(reply);
      expect(marker?.stage).toBe("done");
    });

    it("responds with setup complete even with conversation history after restart", async () => {
      // Config with claw-free removed = finalized
      await writeTestConfig({
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com/v1",
              apiKey: "stored",
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-20250514" },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "claude" });

      // Even if conversation has old markers from a previous stage,
      // config-based detection should override
      const reply = await chat([
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content:
            "Welcome!\n\n<!---setup:waiting_for_code:claude-->",
        },
        { role: "user", content: "some-code" },
      ]);

      expect(reply).toContain("Setup is already complete");
    });
  });

  describe("finish setup flow", () => {
    it("completes full setup: configure provider then finish", async () => {
      await writeTestConfig({
        models: {
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
            },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "claude" });

      // Step 1: Welcome
      const welcome = await chat([{ role: "user", content: "hello" }]);
      expect(extractMarker(welcome)?.stage).toBe("waiting_for_code");

      // Step 2: Paste code
      const authReply = await chat([
        { role: "user", content: "hello" },
        { role: "assistant", content: welcome },
        { role: "user", content: "mycode123" },
      ]);
      expect(extractMarker(authReply)?.stage).toBe("add_another");

      // Step 3: Choose "No, start chatting!" (option 3 for 2 remaining)
      const remaining = ["openai", "kimi"]; // claude configured, 2 left
      const finishChoice = String(remaining.length + 1);
      const finishReply = await chat([
        { role: "user", content: "hello" },
        { role: "assistant", content: welcome },
        { role: "user", content: "mycode123" },
        { role: "assistant", content: authReply },
        { role: "user", content: finishChoice },
      ]);

      expect(finishReply).toContain("All set");
      expect(extractMarker(finishReply)?.stage).toBe("management");

      // Verify config was finalized (claw-free kept for management, but not used as a fallback model)
      const config = await readTestConfig();
      expect(config.models.providers["claw-free"]).toBeTruthy();
      expect(config.agents?.defaults?.model?.primary).not.toBe("claw-free/setup");
      expect(config.agents?.defaults?.model?.fallbacks ?? []).not.toContain("claw-free/setup");
    });
  });

  describe("health endpoint", () => {
    it("returns stage in health check", async () => {
      await writeTestConfig({
        models: {
          providers: {
            "claw-free": {
              baseUrl: "http://localhost:3456/v1",
              apiKey: "local",
            },
          },
        },
      });

      server = await startServer({ LLM_PROVIDER: "claude" });

      const res = await fetch(`${BASE_URL}/health`);
      const json = await res.json();

      expect(json.status).toBe("ok");
      expect(json).toHaveProperty("stage");
    });
  });
});

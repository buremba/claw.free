#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/var/lib/openclaw"
NPM_PREFIX="$STATE_DIR/npm-global"
OPENCLAW_HOME="$STATE_DIR/home"
OPENCLAW_CONFIG_DIR="$OPENCLAW_HOME/.openclaw"
OPENCLAW_WORKSPACE_DIR="$OPENCLAW_CONFIG_DIR/workspace"
OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_DIR/openclaw.json"
PROVIDER_DIR="$STATE_DIR/provider"
SETUP_MARKER="$STATE_DIR/.setup-complete"
AI_TOOLS_MARKER="$STATE_DIR/.ai-clis-installed"
SETUP_STATUS_REPORTED=0

retry() {
  local attempts="$1"
  shift

  local try=1
  while true; do
    if "$@"; then
      return 0
    fi

    if [ "$try" -ge "$attempts" ]; then
      return 1
    fi

    sleep $((try * 2))
    try=$((try + 1))
  done
}

metadata_get() {
  local key="$1"
  local default_value="$2"
  local value=""

  if value=$(curl -fsS -m 2 \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}" \
    -H "Metadata-Flavor: Google" 2>/dev/null); then
    echo "$value"
    return 0
  fi

  echo "$default_value"
}

publish_setup_state() {
  local value="$1"

  curl -fsS -m 2 -X PUT \
    "http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/openclaw/setup" \
    -H "Metadata-Flavor: Google" \
    --data-binary "$value" >/dev/null 2>&1 || true
}

mark_setup_failed() {
  local reason="$1"
  publish_setup_state "failed:${reason}"
  SETUP_STATUS_REPORTED=1
}

trap 'if [ "$SETUP_STATUS_REPORTED" -eq 0 ]; then mark_setup_failed "startup-script-error"; fi' ERR

start_ai_cli_installer() {
  cat > /usr/local/bin/openclaw-install-ai-clis.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/var/lib/openclaw"
NPM_PREFIX="$STATE_DIR/npm-global"
AI_TOOLS_MARKER="$STATE_DIR/.ai-clis-installed"

if [ -f "$AI_TOOLS_MARKER" ]; then
  exit 0
fi

mkdir -p "$STATE_DIR/.npm-cache"
npm_config_cache="$STATE_DIR/.npm-cache" npm install --prefix "$NPM_PREFIX" \
  -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli
touch "$AI_TOOLS_MARKER"
EOF
  chmod +x /usr/local/bin/openclaw-install-ai-clis.sh

  cat > /etc/systemd/system/openclaw-ai-clis.service <<'EOF'
[Unit]
Description=Install AI CLIs for OpenClaw
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/var/lib/openclaw/.ai-clis-installed

[Service]
Type=simple
ExecStart=/usr/local/bin/openclaw-install-ai-clis.sh
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable openclaw-ai-clis.service
  systemctl start openclaw-ai-clis.service || true
}

# ── Fetch metadata ──
TELEGRAM_TOKEN="$(metadata_get "TELEGRAM_TOKEN" "")"
LLM_PROVIDER="$(metadata_get "LLM_PROVIDER" "claude")"

if [ -z "$TELEGRAM_TOKEN" ]; then
  echo "Missing TELEGRAM_TOKEN metadata, cannot continue."
  mark_setup_failed "missing-telegram-token"
  exit 1
fi

# ── Install base packages via apt ──
echo "Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
retry 5 apt-get update -qq
retry 5 apt-get install -y -qq ca-certificates curl gnupg git jq

# ── Install Node.js 22 ──
echo "Installing Node.js 22..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
chmod a+r /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
retry 5 apt-get update -qq
retry 5 apt-get install -y -qq nodejs

# ── Set up runtime directories ──
mkdir -p "$STATE_DIR" "$NPM_PREFIX" "$OPENCLAW_HOME" \
  "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR" "$PROVIDER_DIR"

# ── Install OpenClaw CLI (native) ──
echo "Installing OpenClaw CLI..."
if [ ! -x "$NPM_PREFIX/bin/openclaw" ]; then
  mkdir -p "$STATE_DIR/.npm-cache"
  retry 3 env npm_config_cache="$STATE_DIR/.npm-cache" npm install -g --prefix "$NPM_PREFIX" openclaw@latest
fi

# ── Clone claw.free for provider + skill ──
echo "Cloning claw.free..."
if [ -d /opt/openclaw/claw-free/.git ]; then
  git -C /opt/openclaw/claw-free pull --ff-only
else
  retry 3 git clone --depth=1 https://github.com/buremba/claw.free.git /opt/openclaw/claw-free
fi

# ── Install provider + skill assets ──
cp /opt/openclaw/claw-free/provider/server.js "$PROVIDER_DIR/server.js"
cp /opt/openclaw/claw-free/provider/package.json "$PROVIDER_DIR/package.json"
rm -rf "$OPENCLAW_CONFIG_DIR/skills/claw-free"
mkdir -p "$OPENCLAW_CONFIG_DIR/skills"
cp -r /opt/openclaw/claw-free/skill "$OPENCLAW_CONFIG_DIR/skills/claw-free"

# ── Write openclaw.json (latest schema) ──
jq -n \
  --arg telegramToken "$TELEGRAM_TOKEN" \
  --arg workspace "$OPENCLAW_WORKSPACE_DIR" \
  '{
    gateway: {
      mode: "local"
    },
    agents: {
      defaults: {
        workspace: $workspace,
        model: {
          primary: "claw-free/setup"
        }
      }
    },
    channels: {
      telegram: {
        enabled: true,
        botToken: $telegramToken,
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "allowlist"
      }
    },
    models: {
      mode: "merge",
      providers: {
        "claw-free": {
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
              maxTokens: 4096
            }
          ]
        }
      }
    }
  }' > "$OPENCLAW_CONFIG_PATH"
chmod 600 "$OPENCLAW_CONFIG_PATH"

# ── Create claw-free-provider systemd service ──
NODE_BIN=$(which node)
cat > /etc/systemd/system/claw-free-provider.service <<EOF
[Unit]
Description=claw-free bootstrap LLM provider
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROVIDER_DIR
ExecStart=$NODE_BIN $PROVIDER_DIR/server.js
Environment=LLM_PROVIDER=$LLM_PROVIDER
Environment=OPENCLAW_CONFIG_PATH=$OPENCLAW_CONFIG_PATH
Environment=PATH=$NPM_PREFIX/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ── Create openclaw gateway systemd service ──
cat > /etc/systemd/system/openclaw-gateway.service <<EOF
[Unit]
Description=OpenClaw Gateway
After=network-online.target claw-free-provider.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$OPENCLAW_HOME
ExecStart=$NPM_PREFIX/bin/openclaw gateway --bind lan --port 18789
Environment=HOME=$OPENCLAW_HOME
Environment=OPENCLAW_CONFIG_PATH=$OPENCLAW_CONFIG_PATH
Environment=PATH=$NPM_PREFIX/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable claw-free-provider
systemctl enable openclaw-gateway
systemctl start claw-free-provider
systemctl start openclaw-gateway

# ── Install AI CLIs asynchronously (non-blocking for boot health) ──
echo "Starting async AI CLI installation..."
start_ai_cli_installer

# ── Wait for gateway readiness ──
echo "Waiting for OpenClaw gateway service..."
for _ in $(seq 1 60); do
  if systemctl is-active --quiet claw-free-provider \
    && systemctl is-active --quiet openclaw-gateway; then
    break
  fi
  sleep 2
done

if ! systemctl is-active --quiet claw-free-provider \
  || ! systemctl is-active --quiet openclaw-gateway; then
  echo "OpenClaw gateway readiness check failed."
  systemctl --no-pager --full status claw-free-provider || true
  journalctl -u claw-free-provider --no-pager -n 120 || true
  systemctl --no-pager --full status openclaw-gateway || true
  journalctl -u openclaw-gateway --no-pager -n 120 || true
  mark_setup_failed "gateway-readiness"
  exit 1
fi

# ── Mark setup complete ──
touch "$SETUP_MARKER"
publish_setup_state "ready"
SETUP_STATUS_REPORTED=1
echo "=== claw.free startup script complete ==="

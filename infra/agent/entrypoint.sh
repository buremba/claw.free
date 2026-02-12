#!/usr/bin/env bash
set -euo pipefail

# claw.free agent entrypoint — generates OpenClaw config from env vars
# and starts the gateway.

CONFIG_DIR="$HOME/.openclaw"
CONFIG_PATH="$CONFIG_DIR/openclaw.json"
WORKSPACE="$CONFIG_DIR/workspace"

if [ -z "${TELEGRAM_TOKEN:-}" ]; then
  echo "ERROR: TELEGRAM_TOKEN not set" >&2
  exit 1
fi

PORT="${PORT:-8080}"
BOT_NAME="${BOT_NAME:-openclaw-agent}"

# Install skills if available
if [ -d /etc/openclaw/skill ]; then
  mkdir -p "$CONFIG_DIR/skills"
  rm -rf "$CONFIG_DIR/skills/claw-free"
  cp -R /etc/openclaw/skill "$CONFIG_DIR/skills/claw-free"
fi

# Generate config — always starts with the bootstrap model provider.
# Users configure their real LLM through the bot's interactive setup flow.
cat > "$CONFIG_PATH" <<CONF
{
  "gateway": {
    "mode": "local"
  },
  "agents": {
    "defaults": {
      "workspace": "$WORKSPACE",
      "model": {
        "primary": "claw-free/setup"
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "$TELEGRAM_TOKEN",
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "groupPolicy": "allowlist"
    }
  },
  "plugins": {
    "entries": {
      "telegram": { "enabled": true }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "claw-free": {
        "baseUrl": "http://localhost:3456/v1",
        "apiKey": "local",
        "api": "openai-completions",
        "models": [{
          "id": "setup",
          "name": "claw.free Setup",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 4096
        }]
      }
    }
  }
}
CONF

chmod 600 "$CONFIG_PATH"

# Generate a gateway token if not set
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(head -c 32 /dev/urandom | base64)}"

# Create required directories for openclaw
mkdir -p "$CONFIG_DIR/agents/main/sessions" "$CONFIG_DIR/credentials"
chmod 700 "$CONFIG_DIR"

echo "Starting OpenClaw agent (port=$PORT, bot=$BOT_NAME)"
exec openclaw gateway --bind auto --port "$PORT"

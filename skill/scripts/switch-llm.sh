#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/var/lib/openclaw"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/home/.openclaw/openclaw.json}"

PROVIDER="${1:-}"

if [ -z "$PROVIDER" ]; then
  echo "Usage: switch-llm.sh <provider>"
  echo "  Providers: claude, openai"
  exit 1
fi

if [ "$PROVIDER" != "claude" ] && [ "$PROVIDER" != "openai" ]; then
  echo "Unknown provider: $PROVIDER"
  echo "  Supported: claude, openai"
  exit 1
fi

echo "=== Switching to $PROVIDER ==="

# Re-enable claw-free-provider for auth flow
echo "Restarting claw-free-provider..."
mkdir -p /etc/systemd/system/claw-free-provider.service.d
cat > /etc/systemd/system/claw-free-provider.service.d/override.conf <<EOF
[Service]
Environment=LLM_PROVIDER=$PROVIDER
EOF

systemctl daemon-reload
systemctl restart claw-free-provider

# Update openclaw.json to use claw-free provider temporarily
python3 -c "
import json

with open('$OPENCLAW_CONFIG_PATH') as f:
    config = json.load(f)

# Add back claw-free provider
config.setdefault('models', {}).setdefault('providers', {})
config['models']['providers']['claw-free'] = {
    'baseUrl': 'http://localhost:3456/v1',
    'apiKey': 'local',
    'api': 'openai-completions',
    'models': [{
        'id': 'setup',
        'name': 'claw.free Setup',
        'reasoning': False,
        'input': ['text'],
        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
        'contextWindow': 128000,
        'maxTokens': 4096
    }]
}
config.setdefault('gateway', {})['mode'] = 'local'
config.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'claw-free/setup'

with open('$OPENCLAW_CONFIG_PATH', 'w') as f:
    json.dump(config, f, indent=2)
"

# Restart OpenClaw
systemctl restart openclaw-gateway

echo ""
echo "Done! Message your bot on Telegram to start the $PROVIDER auth flow."

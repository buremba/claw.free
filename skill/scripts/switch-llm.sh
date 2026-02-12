#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/var/lib/openclaw"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/home/.openclaw/openclaw.json}"

PROVIDER="${1:-}"

if [ -z "$PROVIDER" ]; then
  echo "Usage: switch-llm.sh <provider>"
  echo "  Providers: claude, openai, kimi"
  exit 1
fi

case "$PROVIDER" in
  claude|openai|kimi) ;;
  *)
    echo "Unknown provider: $PROVIDER"
    echo "  Supported: claude, openai, kimi"
    exit 1
    ;;
esac

echo "=== Switching to $PROVIDER ==="

# Set the provider hint and restart the claw-free-provider service
echo "Restarting claw-free-provider..."
mkdir -p /etc/systemd/system/claw-free-provider.service.d
cat > /etc/systemd/system/claw-free-provider.service.d/override.conf <<EOF
[Service]
Environment=LLM_PROVIDER=$PROVIDER
EOF

systemctl daemon-reload
systemctl restart claw-free-provider

# Update openclaw.json to use claw-free provider as primary temporarily.
# The claw-free provider already stays in the config as a fallback,
# so we just need to promote it to primary for the auth flow.
python3 -c "
import json

with open('$OPENCLAW_CONFIG_PATH') as f:
    config = json.load(f)

# Ensure claw-free provider exists in config (should already be there)
config.setdefault('models', {}).setdefault('providers', {})
if 'claw-free' not in config['models']['providers']:
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

# Temporarily set claw-free/setup as primary for the auth flow
config.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'claw-free/setup'

with open('$OPENCLAW_CONFIG_PATH', 'w') as f:
    json.dump(config, f, indent=2)
"

# Restart OpenClaw gateway to pick up the new primary model
systemctl restart openclaw-gateway

echo ""
echo "Done! Message your bot on Telegram to start the $PROVIDER auth flow."

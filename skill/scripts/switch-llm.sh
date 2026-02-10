#!/usr/bin/env bash
set -euo pipefail

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
cat > /etc/systemd/system/claw-free-provider.service.d/override.conf <<EOF
[Service]
Environment=LLM_PROVIDER=$PROVIDER
EOF

systemctl daemon-reload
systemctl restart claw-free-provider

# Update openclaw.json to use claw-free provider temporarily
python3 -c "
import json

with open('/opt/openclaw/openclaw.json') as f:
    config = json.load(f)

# Add back claw-free provider
config.setdefault('models', {}).setdefault('providers', {})
config['models']['providers']['claw-free'] = {
    'baseUrl': 'http://localhost:3456/v1',
    'apiKey': 'local',
    'api': 'openai-completions',
    'models': [{'id': 'setup', 'name': 'claw.free Setup'}]
}
config['models']['primaryModel'] = 'claw-free/setup'

with open('/opt/openclaw/openclaw.json', 'w') as f:
    json.dump(config, f, indent=2)
"

# Restart OpenClaw
cd /opt/openclaw/app
docker compose restart

echo ""
echo "Done! Message your bot on Telegram to start the $PROVIDER auth flow."

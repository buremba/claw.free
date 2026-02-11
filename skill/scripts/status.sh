#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/var/lib/openclaw"
NPM_PREFIX="${STATE_DIR}/npm-global"
OPENCLAW_BIN="${NPM_PREFIX}/bin/openclaw"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/home/.openclaw/openclaw.json}"

echo "=== claw.free Status ==="
echo ""

echo "── Services ──"
for unit in openclaw-setup claw-free-provider openclaw-gateway openclaw-ai-tools; do
  status="$(systemctl is-active "$unit" 2>/dev/null || true)"
  if [ -z "$status" ]; then
    status="not-found"
  fi
  printf "  %-20s %s\n" "$unit" "$status"
done
echo ""

echo "── Resource Usage ──"
echo "Memory:"
free -h | grep -E "^Mem:" | awk '{printf "  Used: %s / %s (Available: %s)\n", $3, $2, $7}'
echo ""

echo "Disk:"
df -h / | tail -1 | awk '{printf "  Used: %s / %s (%s)\n", $3, $2, $5}'
echo ""

echo "── Uptime ──"
uptime
echo ""

echo "── claw-free-provider ──"
systemctl is-active claw-free-provider 2>/dev/null && echo "  Status: running" || echo "  Status: stopped"
curl -s http://localhost:3456/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Stage: {d[\"stage\"]}')" 2>/dev/null || true
echo ""

echo "── OpenClaw Config ──"
if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  python3 -c "
import json
with open('$OPENCLAW_CONFIG_PATH') as f:
    c = json.load(f)
pm = c.get('agents', {}).get('defaults', {}).get('model', {}).get('primary', 'not set')
print(f'  Primary model: {pm}')
alts = c.get('agents', {}).get('defaults', {}).get('model', {}).get('fallbacks', [])
if alts:
    print(f'  Alternative models: {\", \".join(alts)}')
"
else
  echo "  Config not found"
fi

if [ -x "$OPENCLAW_BIN" ]; then
  echo ""
  echo "── OpenClaw CLI ──"
  echo "  Version: $($OPENCLAW_BIN --version 2>/dev/null || echo unknown)"
fi

#!/usr/bin/env bash
set -euo pipefail

echo "=== claw.free Status ==="
echo ""

echo "── Docker Containers ──"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Docker not running"
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
if [ -f /opt/openclaw/openclaw.json ]; then
  python3 -c "
import json
with open('/opt/openclaw/openclaw.json') as f:
    c = json.load(f)
pm = c.get('models', {}).get('primaryModel', 'not set')
print(f'  Primary model: {pm}')
alts = c.get('models', {}).get('alternativeModels', [])
if alts:
    print(f'  Alternative models: {\", \".join(alts)}')
"
else
  echo "  Config not found"
fi

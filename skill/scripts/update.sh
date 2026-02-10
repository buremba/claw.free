#!/usr/bin/env bash
set -euo pipefail

echo "=== Updating OpenClaw ==="

cd /opt/openclaw/app

echo "Pulling latest images..."
docker compose pull

echo "Restarting OpenClaw..."
docker compose up -d

echo "Cleaning up old images..."
docker image prune -f

echo ""
echo "Update complete!"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

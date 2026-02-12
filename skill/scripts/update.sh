#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/var/lib/openclaw"
NPM_PREFIX="${STATE_DIR}/npm-global"
OPENCLAW_BIN="${NPM_PREFIX}/bin/openclaw"

echo "=== Updating OpenClaw ==="

mkdir -p "${STATE_DIR}/.npm-cache"
echo "Installing latest OpenClaw CLI..."
npm_config_cache="${STATE_DIR}/.npm-cache" npm install -g --prefix "${NPM_PREFIX}" openclaw@latest

echo ""
echo "Restarting services..."
systemctl restart claw-free-provider openclaw-gateway

echo "Update complete."
echo "OpenClaw version: $(${OPENCLAW_BIN} --version 2>/dev/null || echo unknown)"
systemctl --no-pager --full status openclaw-gateway | sed -n '1,8p'

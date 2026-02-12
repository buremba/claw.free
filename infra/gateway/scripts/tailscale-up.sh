#!/bin/sh
# Wait for tailscaled to be ready, then join the Headscale overlay.
# Runs once at startup (autorestart=false in supervisord).

set -e

SOCKET="/var/run/tailscale/tailscaled.sock"
MAX_WAIT=30
WAITED=0

# Wait for tailscaled socket
while [ ! -S "$SOCKET" ] && [ "$WAITED" -lt "$MAX_WAIT" ]; do
  sleep 1
  WAITED=$((WAITED + 1))
done

if [ ! -S "$SOCKET" ]; then
  echo "ERROR: tailscaled socket not ready after ${MAX_WAIT}s" >&2
  exit 1
fi

# Join the Headscale network
# TAILSCALE_AUTHKEY: pre-auth key from Headscale (user=gateway)
# HEADSCALE_URL: Headscale control server URL
tailscale up \
  --login-server="${HEADSCALE_URL}" \
  --authkey="${TAILSCALE_AUTHKEY}" \
  --hostname="gateway" \
  --accept-routes \
  --accept-dns=true

echo "Tailscale connected to Headscale overlay"
tailscale status

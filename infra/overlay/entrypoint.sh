#!/bin/sh
set -e

# Defaults — override via environment variables
export PORT="${PORT:-8080}"
export HEADSCALE_SERVER_URL="${HEADSCALE_SERVER_URL:-http://localhost:8080}"
export HEADSCALE_BASE_DOMAIN="${HEADSCALE_BASE_DOMAIN:-claw.internal}"
export DERP_VERIFY_CLIENTS="${DERP_VERIFY_CLIENTS:-true}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

# Render config template
envsubst < /etc/headscale/config.yaml.tmpl > /etc/headscale/config.yaml

mkdir -p /var/lib/headscale

# Create headscale users (namespaces) if they don't exist yet.
# These map to network roles in our ACL policy.
for user in gateway bots admin; do
  headscale users create "$user" --config /etc/headscale/config.yaml 2>/dev/null || true
done

exec headscale serve --config /etc/headscale/config.yaml

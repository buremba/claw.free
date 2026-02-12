#!/bin/sh
set -e

# Defaults
export PORT_HTTP="${PORT_HTTP:-80}"
export PORT_HTTPS="${PORT_HTTPS:-443}"
export PORT_SQUID="${PORT_SQUID:-3128}"
export BOT_DOMAIN="${BOT_DOMAIN:-bots.example.com}"
export HEADSCALE_URL="${HEADSCALE_URL:-https://hs.example.com}"
export GATEWAY_UPSTREAM="${GATEWAY_UPSTREAM:-localhost:18789}"
export LEGO_DNS_PROVIDER="${LEGO_DNS_PROVIDER:-cloudflare}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export ALLOWLIST_API_URL="${ALLOWLIST_API_URL:-}"

# Render config templates
envsubst < /etc/caddy/Caddyfile.tmpl > /etc/caddy/Caddyfile
envsubst < /etc/squid/squid.conf.tmpl > /etc/squid/squid.conf

# Ensure dirs exist
mkdir -p /var/lib/tailscale /etc/certs /var/spool/squid /var/log/gateway

# Initialize Squid cache if needed
squid -z -f /etc/squid/squid.conf 2>/dev/null || true

# Start supervisord (manages tailscaled, caddy, squid, cert-renew)
exec supervisord -c /etc/supervisord.conf

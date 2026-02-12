#!/bin/sh
# Squid external_acl helper — checks if a bot is allowed to access a domain.
#
# Input (from Squid, one line per request):
#   <bot-tailscale-ip> <requested-domain>
#
# Output:
#   OK    — allow the request
#   ERR   — deny the request
#
# If ALLOWLIST_API_URL is set, queries the Railway API:
#   GET ${ALLOWLIST_API_URL}/api/internal/allowlist?ip=<ip>&domain=<domain>
#   Response: {"allowed": true/false}
#
# If ALLOWLIST_API_URL is empty, allows all traffic (open mode).

while read src_ip dst_domain; do
  if [ -z "$ALLOWLIST_API_URL" ]; then
    # Open mode — no allowlist enforcement
    echo "OK"
    continue
  fi

  result=$(curl -sf \
    -H "X-Internal-Key: ${INTERNAL_API_KEY}" \
    "${ALLOWLIST_API_URL}/api/internal/allowlist?ip=${src_ip}&domain=${dst_domain}" \
    2>/dev/null)

  if echo "$result" | grep -q '"allowed":true'; then
    echo "OK"
  else
    echo "ERR"
  fi
done

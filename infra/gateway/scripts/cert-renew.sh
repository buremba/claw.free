#!/bin/sh
# Wildcard certificate renewal loop using lego.
# Runs continuously, renewing every 60 days (certs valid for 90).
#
# DNS provider is configured via LEGO_DNS_PROVIDER env var.
# Provider-specific credentials are passed as env vars (e.g. CLOUDFLARE_DNS_API_TOKEN).
# See https://go-acme.github.io/lego/dns/ for all supported providers.

set -e

CERT_DIR="/etc/certs"
LEGO_DIR="/var/lib/lego"
DOMAIN="*.${BOT_DOMAIN}"
RENEW_INTERVAL=5184000  # 60 days in seconds

mkdir -p "$CERT_DIR" "$LEGO_DIR"

obtain_cert() {
  echo "Obtaining wildcard certificate for ${DOMAIN}..."
  lego \
    --accept-tos \
    --email="${ACME_EMAIL}" \
    --dns="${LEGO_DNS_PROVIDER}" \
    --domains="${DOMAIN}" \
    --path="${LEGO_DIR}" \
    run

  # Copy to where Caddy expects them
  cp "${LEGO_DIR}/certificates/${BOT_DOMAIN}.crt" "${CERT_DIR}/cert.pem"
  cp "${LEGO_DIR}/certificates/${BOT_DOMAIN}.key" "${CERT_DIR}/key.pem"
  echo "Certificate obtained and installed."
}

renew_cert() {
  echo "Renewing wildcard certificate for ${DOMAIN}..."
  lego \
    --accept-tos \
    --email="${ACME_EMAIL}" \
    --dns="${LEGO_DNS_PROVIDER}" \
    --domains="${DOMAIN}" \
    --path="${LEGO_DIR}" \
    renew --days 30

  cp "${LEGO_DIR}/certificates/${BOT_DOMAIN}.crt" "${CERT_DIR}/cert.pem"
  cp "${LEGO_DIR}/certificates/${BOT_DOMAIN}.key" "${CERT_DIR}/key.pem"
  echo "Certificate renewed and installed."

  # Reload Caddy to pick up new cert
  caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true
}

# Initial obtain if no cert exists
if [ ! -f "${CERT_DIR}/cert.pem" ]; then
  obtain_cert
fi

# Renewal loop
while true; do
  sleep "$RENEW_INTERVAL"
  renew_cert
done

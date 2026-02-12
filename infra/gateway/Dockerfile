# claw.free gateway — reverse proxy + outbound proxy + overlay client
#
# Runs on any VM (GCP, AWS, Hetzner, etc.) via Docker Compose.
# NOT for Railway — Railway can't run Tailscale or bind raw ports.
#
# Services managed by supervisord inside a single container:
#   - Tailscale client (connects to Headscale overlay)
#   - Caddy (TLS termination, reverse proxy for inbound bot webhooks)
#   - Squid (outbound HTTP proxy with domain allowlist)
#   - lego (wildcard cert renewal via DNS challenge)

FROM alpine:3.21

ARG TAILSCALE_VERSION=1.78.1
ARG CADDY_VERSION=2.9.1
ARG LEGO_VERSION=4.21.0

# Install base packages
RUN apk add --no-cache \
    supervisor \
    squid \
    curl \
    ca-certificates \
    tzdata \
    gettext \
    iptables \
    ip6tables

# Install Tailscale
RUN curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
    | tar -xzf - -C /usr/local/bin --strip-components=1 \
      "tailscale_${TAILSCALE_VERSION}_amd64/tailscale" \
      "tailscale_${TAILSCALE_VERSION}_amd64/tailscaled"

# Install Caddy
RUN curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" \
    | tar -xzf - -C /usr/local/bin caddy

# Install lego (ACME client for wildcard certs)
RUN curl -fsSL "https://github.com/go-acme/lego/releases/download/v${LEGO_VERSION}/lego_v${LEGO_VERSION}_linux_amd64.tar.gz" \
    | tar -xzf - -C /usr/local/bin lego

# Config templates
COPY config/Caddyfile.tmpl /etc/caddy/Caddyfile.tmpl
COPY config/squid.conf.tmpl /etc/squid/squid.conf.tmpl
COPY config/supervisord.conf /etc/supervisord.conf

# Scripts
COPY entrypoint.sh /entrypoint.sh
COPY scripts/ /usr/local/lib/gateway/
RUN chmod +x /entrypoint.sh /usr/local/lib/gateway/*.sh

# Persistent data: certs, tailscale state, squid cache
VOLUME /var/lib/tailscale
VOLUME /etc/certs
VOLUME /var/spool/squid

EXPOSE 80 443 3128

ENTRYPOINT ["/entrypoint.sh"]

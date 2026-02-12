# Headscale overlay control plane
# Self-hosted Tailscale-compatible coordination server
#
# Uses Alpine base (instead of upstream distroless) so we can
# run envsubst to render config templates from environment variables.

FROM headscale/headscale:0.28.0 AS headscale-bin

FROM alpine:3.21

RUN apk add --no-cache gettext ca-certificates tzdata

# Extract headscale binary from official image (ko places it at /ko-app/)
COPY --from=headscale-bin /ko-app/headscale /usr/local/bin/headscale

# Config template + ACL policy
COPY config/headscale.yaml.tmpl /etc/headscale/config.yaml.tmpl
COPY config/acl.json /etc/headscale/acl.json

# Entrypoint renders config from env vars, then starts headscale
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && \
    mkdir -p /var/lib/headscale

EXPOSE 8080 3478/udp

VOLUME /var/lib/headscale

ENTRYPOINT ["/entrypoint.sh"]

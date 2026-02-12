# claw.free agent image — runs an OpenClaw Telegram bot as a standalone service.
#
# Used by Railway provider: each user agent is a separate Railway service
# built from this image. Telegram webhooks go directly to the service URL.
#
# Env vars (set by the Railway provider):
#   TELEGRAM_TOKEN  — Bot token from @BotFather
#   BOT_NAME        — Sanitized agent name
#   WEBHOOK_SECRET  — Shared secret for X-Telegram-Bot-Api-Secret-Token
#   WEBHOOK_URL     — Public URL for Telegram to send webhooks to
#   DEPLOYMENT_ID   — Platform deployment ID
#   PORT            — Listening port (auto-set by Railway)

FROM --platform=linux/amd64 node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates python3 gcc g++ make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install project dependencies
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts

# Pre-install openclaw globally so it's available without npx download on each start
RUN npm install -g openclaw@latest

# Copy skill definitions + relay client (relay not used in Railway mode, but
# included for completeness if the image is reused in GCP Docker mode)
COPY skill/ /etc/openclaw/skill/
COPY infra/relay-client/tunnel.mjs /etc/openclaw/relay-client/tunnel.mjs

COPY infra/agent/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV HOME=/home/agent
RUN useradd -m -d /home/agent -s /bin/bash agent
USER agent

RUN mkdir -p /home/agent/.openclaw/workspace

ENTRYPOINT ["/entrypoint.sh"]

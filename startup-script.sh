#!/usr/bin/env bash
set -euo pipefail

# ── Fetch metadata ──
TELEGRAM_TOKEN=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/TELEGRAM_TOKEN" -H "Metadata-Flavor: Google")
LLM_PROVIDER=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/LLM_PROVIDER" -H "Metadata-Flavor: Google")

# ── Install Nix (multi-user, daemon mode) ──
echo "Installing Nix..."
sh <(curl -L https://nixos.org/nix/install) --daemon --yes

# Source Nix profile for this script
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

# Enable flakes
mkdir -p /etc/nix
cat > /etc/nix/nix.conf <<'NIXCONF'
experimental-features = nix-command flakes
NIXCONF

# ── Install packages via Nix ──
echo "Installing packages via Nix..."
nix profile install nixpkgs#nodejs_22 nixpkgs#docker-compose nixpkgs#git nixpkgs#jq

# ── Install Docker (still via apt — Docker daemon needs systemd integration) ──
echo "Installing Docker..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

# ── Install Claude Code CLI and Codex CLI via npm (from Nix Node.js) ──
echo "Installing Claude Code CLI and Codex CLI..."
npm install -g @anthropic-ai/claude-code @openai/codex

# ── Set up OpenClaw directory ──
mkdir -p /opt/openclaw
cd /opt/openclaw

# ── Clone OpenClaw ──
echo "Cloning OpenClaw..."
git clone https://github.com/buremba/openclaw.git /opt/openclaw/app

# ── Clone claw-free-deploy for provider + skill ──
echo "Cloning claw-free-deploy..."
git clone https://github.com/buremba/claw-free-deploy.git /opt/openclaw/claw-free

# ── Install claw-free-provider dependencies ──
cd /opt/openclaw/claw-free/provider
npm install --production

# ── Write openclaw.json ──
cat > /opt/openclaw/openclaw.json <<EOF
{
  "channels": {
    "telegram": {
      "token": "$TELEGRAM_TOKEN",
      "allowedUsers": []
    }
  },
  "models": {
    "providers": {
      "claw-free": {
        "baseUrl": "http://localhost:3456/v1",
        "apiKey": "local",
        "api": "openai-completions",
        "models": [{ "id": "setup", "name": "claw.free Setup" }]
      }
    },
    "primaryModel": "claw-free/setup"
  }
}
EOF

# ── Create claw-free-provider systemd service ──
NODE_BIN=$(which node)
cat > /etc/systemd/system/claw-free-provider.service <<EOF
[Unit]
Description=claw-free bootstrap LLM provider
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/openclaw/claw-free/provider
ExecStart=$NODE_BIN server.js
Environment=LLM_PROVIDER=$LLM_PROVIDER
Environment=OPENCLAW_CONFIG_PATH=/opt/openclaw/openclaw.json
Environment=PATH=/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable claw-free-provider
systemctl start claw-free-provider

# ── Install claw.free skill ──
echo "Installing claw.free skill..."
mkdir -p /opt/openclaw/skills
cp -r /opt/openclaw/claw-free/skill /opt/openclaw/skills/claw-free

# ── Start OpenClaw via Docker Compose ──
echo "Starting OpenClaw..."
cd /opt/openclaw/app
docker compose up -d

# ── Mark setup complete ──
touch /opt/openclaw/.setup-complete
echo "=== claw.free startup script complete ==="

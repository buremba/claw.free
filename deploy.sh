#!/usr/bin/env bash
set -euo pipefail

# ── Configuration from environment (set by Cloud Shell URL params) ──
PROJECT_ID="${DEVSHELL_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GCP_REGION:-us-central1}"
ZONE="${REGION}-a"
VM_NAME="openclaw-vm"
LLM_PROVIDER="${LLM_PROVIDER:-claude}"

echo "=== claw.free Deployment ==="
echo "Project:    $PROJECT_ID"
echo "Region:     $REGION"
echo "Zone:       $ZONE"
echo "LLM:        $LLM_PROVIDER"
echo ""

# ── Prompt for Telegram credentials if not set ──
if [ -z "${TELEGRAM_TOKEN:-}" ]; then
  read -rp "Enter your Telegram bot token: " TELEGRAM_TOKEN
fi
if [ -z "${TELEGRAM_USER_ID:-}" ]; then
  # Try to auto-detect from bot token
  echo "Detecting your Telegram user ID..."
  echo "Make sure you've sent a message to your bot first."
  UPDATES=$(curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?limit=10&offset=-10" 2>/dev/null || true)
  DETECTED_ID=$(echo "$UPDATES" | grep -o '"from":{"id":[0-9]*' | head -1 | grep -o '[0-9]*$' || true)
  if [ -n "$DETECTED_ID" ]; then
    echo "Detected user ID: $DETECTED_ID"
    read -rp "Use this ID? [Y/n] " CONFIRM
    if [ "${CONFIRM,,}" != "n" ]; then
      TELEGRAM_USER_ID="$DETECTED_ID"
    else
      read -rp "Enter your Telegram user ID: " TELEGRAM_USER_ID
    fi
  else
    echo "Could not auto-detect. Send a message to your bot and try again, or enter manually."
    read -rp "Enter your Telegram user ID: " TELEGRAM_USER_ID
  fi
fi

# ── Prompt for NVIDIA API key if Kimi ──
if [ "$LLM_PROVIDER" = "kimi" ] && [ -z "${NVIDIA_API_KEY:-}" ]; then
  read -rp "Enter your NVIDIA API key (from build.nvidia.com): " NVIDIA_API_KEY
fi

echo ""
echo "Telegram Token: ${TELEGRAM_TOKEN:0:10}..."
echo "Telegram User:  $TELEGRAM_USER_ID"
echo ""

# ── Set project ──
gcloud config set project "$PROJECT_ID"

# ── Enable Compute Engine API ──
echo "Enabling Compute Engine API..."
gcloud services enable compute.googleapis.com --quiet

# ── Create firewall rule for OpenClaw API (port 18789) ──
echo "Creating firewall rule..."
gcloud compute firewall-rules create openclaw-allow-api \
  --allow=tcp:18789 \
  --target-tags=openclaw \
  --description="Allow OpenClaw API traffic" \
  --quiet 2>/dev/null || echo "Firewall rule already exists, skipping."

# ── Build metadata ──
METADATA="startup-script-url=https://raw.githubusercontent.com/buremba/claw-free-deploy/main/startup-script.sh"
METADATA+=",TELEGRAM_TOKEN=$TELEGRAM_TOKEN"
METADATA+=",TELEGRAM_USER_ID=$TELEGRAM_USER_ID"
METADATA+=",LLM_PROVIDER=$LLM_PROVIDER"

if [ "$LLM_PROVIDER" = "kimi" ]; then
  METADATA+=",NVIDIA_API_KEY=${NVIDIA_API_KEY:-}"
  METADATA+=",LLM_BASE_URL=${LLM_BASE_URL:-https://integrate.api.nvidia.com/v1/chat/completions}"
  METADATA+=",LLM_MODEL_ID=${LLM_MODEL_ID:-moonshotai/kimi-k2.5}"
fi

# ── Create the VM ──
echo "Creating e2-micro VM..."
gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=30GB \
  --boot-disk-type=pd-standard \
  --tags=openclaw \
  --metadata="$METADATA" \
  --scopes=default \
  --quiet

# ── Wait for VM to be running ──
echo "Waiting for VM to start..."
gcloud compute instances describe "$VM_NAME" \
  --zone="$ZONE" \
  --format="value(status)" | grep -q RUNNING

# ── Wait for startup script to complete ──
echo "Waiting for startup script to complete (this takes a few minutes)..."
for i in $(seq 1 60); do
  RESULT=$(gcloud compute ssh "$VM_NAME" --zone="$ZONE" --command="test -f /opt/openclaw/.setup-complete && echo done" 2>/dev/null || true)
  if [ "$RESULT" = "done" ]; then
    echo "Setup complete!"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "Warning: Setup is still running. It may complete after you exit."
    echo "You can check status with: gcloud compute ssh $VM_NAME --zone=$ZONE --command='journalctl -u google-startup-scripts -f'"
  fi
  sleep 10
done

# ── Get external IP ──
EXTERNAL_IP=$(gcloud compute instances describe "$VM_NAME" \
  --zone="$ZONE" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)")

echo ""
echo "==============================="
echo "   Deployment Complete"
echo "==============================="
echo ""
echo "VM IP:        $EXTERNAL_IP"
echo "OpenClaw API: http://$EXTERNAL_IP:18789"
echo ""
echo "Next steps:"
echo "  1. Open Telegram and message your bot"
echo "  2. Follow the auth instructions your bot sends you"
echo "  3. Start chatting!"
echo ""

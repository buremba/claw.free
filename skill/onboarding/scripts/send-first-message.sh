#!/bin/bash
set -euo pipefail
BOT_TOKEN="$1"
USER_ID="$2"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{
    \"chat_id\": \"${USER_ID}\",
    \"text\": \"Hello! I'm your AI assistant, powered by claw.free. Send me a message to get started!\"
  }"

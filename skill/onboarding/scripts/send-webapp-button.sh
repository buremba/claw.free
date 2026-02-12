#!/bin/bash
set -euo pipefail
CHAT_ID="$1"
TEXT="${2:-Tap below to set up your bot:}"

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN not set" >&2
  exit 1
fi

if [ -z "$BASE_URL" ]; then
  echo "ERROR: BASE_URL not set" >&2
  exit 1
fi

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{
    \"chat_id\": \"${CHAT_ID}\",
    \"text\": \"${TEXT}\",
    \"reply_markup\": {
      \"inline_keyboard\": [[{
        \"text\": \"Open Setup\",
        \"web_app\": { \"url\": \"${BASE_URL}/mini\" }
      }]]
    }
  }"

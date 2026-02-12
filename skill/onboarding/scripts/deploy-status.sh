#!/bin/bash
set -euo pipefail
DEPLOYMENT_ID="$1"

if [ -z "$BASE_URL" ] || [ -z "$INTERNAL_API_KEY" ]; then
  echo "ERROR: BASE_URL and INTERNAL_API_KEY must be set" >&2
  exit 1
fi

curl -s "${BASE_URL}/api/deploy/${DEPLOYMENT_ID}" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY}" | jq .

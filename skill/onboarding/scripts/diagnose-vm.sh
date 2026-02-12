#!/bin/bash
set -euo pipefail
DEPLOYMENT_ID="$1"

if [ -z "$BASE_URL" ] || [ -z "$INTERNAL_API_KEY" ]; then
  echo "ERROR: BASE_URL and INTERNAL_API_KEY must be set" >&2
  exit 1
fi

VM_INFO=$(curl -s "${BASE_URL}/api/deploy/${DEPLOYMENT_ID}" \
  -H "X-Internal-Key: ${INTERNAL_API_KEY}")
VM_NAME=$(echo "$VM_INFO" | jq -r '.vmName // empty')
VM_ZONE=$(echo "$VM_INFO" | jq -r '.vmZone // empty')

if [ -z "$VM_NAME" ] || [ -z "$VM_ZONE" ]; then
  echo "ERROR: Could not determine VM details for deployment ${DEPLOYMENT_ID}" >&2
  exit 1
fi

echo "Diagnosing VM: ${VM_NAME} in ${VM_ZONE}"
gcloud compute ssh "$VM_NAME" --zone="$VM_ZONE" --tunnel-through-iap \
  --command="systemctl status openclaw-gateway; journalctl -u openclaw-gateway --no-pager -n 50; df -h; free -h"

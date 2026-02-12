#!/bin/bash
set -euo pipefail
DEPLOYMENT_ID="$1"

if ! [[ "$DEPLOYMENT_ID" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "ERROR: Invalid deployment ID format" >&2
  exit 1
fi

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

# Validate formats to prevent injection via crafted API responses
if ! [[ "$VM_NAME" =~ ^[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]; then
  echo "ERROR: Invalid VM name format: ${VM_NAME}" >&2
  exit 1
fi
if ! [[ "$VM_ZONE" =~ ^[a-z]+-[a-z]+[0-9]-[a-z]$ ]]; then
  echo "ERROR: Invalid zone format: ${VM_ZONE}" >&2
  exit 1
fi

echo "Diagnosing VM: ${VM_NAME} in ${VM_ZONE}"
gcloud compute ssh "$VM_NAME" --zone="$VM_ZONE" --tunnel-through-iap \
  --command="systemctl status openclaw-gateway; journalctl -u openclaw-gateway --no-pager -n 50; df -h; free -h"

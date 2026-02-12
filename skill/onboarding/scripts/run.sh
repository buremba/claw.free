#!/bin/bash
set -euo pipefail
ALLOWED="send-webapp-button|deploy-status|send-first-message|diagnose-vm"
SCRIPT="$1"; shift
if [[ "$SCRIPT" =~ ^($ALLOWED)$ ]]; then
  exec bash "$(dirname "$0")/${SCRIPT}.sh" "$@"
else
  echo "ERROR: Unknown command: $SCRIPT" >&2
  exit 1
fi

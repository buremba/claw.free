#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:8788}"

tmp_body="$(mktemp)"
cleanup() {
  rm -f "$tmp_body"
}
trap cleanup EXIT

req() {
  local method="$1"
  local path="$2"
  local url="${BASE_URL%/}${path}"

  # Prints: "<status> <content-type>"
  curl -sS -L -X "$method" -o "$tmp_body" -w '%{http_code} %{content_type}' "$url"
}

expect_ok_text() {
  local got
  got="$(curl -fsS -L "${BASE_URL%/}$1")"
  if [[ "$got" != "$2" ]]; then
    echo "FAIL $1: expected body '$2', got '$got'" >&2
    exit 1
  fi
}

expect_json_error() {
  local path="$1"
  local expected_status="$2"
  local expected_substring="$3"

  local out status ctype
  out="$(req GET "$path")"
  status="${out%% *}"
  ctype="${out#* }"

  if [[ "$status" != "$expected_status" ]]; then
    echo "FAIL $path: expected status $expected_status, got $status" >&2
    echo "Body:" >&2
    cat "$tmp_body" >&2
    exit 1
  fi

  if [[ "$ctype" != application/json* ]]; then
    echo "FAIL $path: expected application/json content-type, got '$ctype'" >&2
    echo "Body:" >&2
    cat "$tmp_body" >&2
    exit 1
  fi

  if ! grep -F -q "$expected_substring" "$tmp_body"; then
    echo "FAIL $path: expected body to include '$expected_substring'" >&2
    echo "Body:" >&2
    cat "$tmp_body" >&2
    exit 1
  fi
}

echo "Smoke testing: $BASE_URL"

expect_ok_text "/healthz" "ok"
expect_json_error "/relay/status" "401" "Unauthorized"
expect_json_error "/api/mini/bots" "401" "Unauthorized"
expect_json_error "/api/internal/allowlist" "401" "Unauthorized"
expect_json_error "/api/deploy/session" "401" "Not logged in"

echo "OK"

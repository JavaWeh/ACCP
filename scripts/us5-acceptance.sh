#!/usr/bin/env bash
# US-5 manual acceptance: verify GitHub sync with a real server token against
# the private fixture repository. The token is taken from the environment
# (ACCP_GITHUB_TOKEN) and is never printed or embedded here.
#
# Usage:
#   ACCP_GITHUB_TOKEN="$(gh auth token)" scripts/us5-acceptance.sh
#
# If ACCP_GITHUB_TOKEN is unset, the script falls back to `gh auth token` for
# convenience. The token is only ever held in the environment at runtime.
set -euo pipefail

if [ -z "${ACCP_GITHUB_TOKEN:-}" ]; then
  if command -v gh >/dev/null 2>&1; then
    export ACCP_GITHUB_TOKEN="$(gh auth token)"
  fi
fi

if [ -z "${ACCP_GITHUB_TOKEN:-}" ]; then
  echo "FAIL: ACCP_GITHUB_TOKEN is not set and gh auth token is unavailable" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

echo "Running US-5 live gitprovider acceptance (success + invalid-token)..."
if go test ./internal/gitprovider/ -run Live -count=1 -v; then
  echo "PASS: US-5 live sync acceptance"
  echo "Expected digest: sha256:3fde37306691f066c3685332ffebb42a4dba01d33e78a83bc540589d526951be"
  exit 0
else
  echo "FAIL: US-5 live sync acceptance" >&2
  exit 1
fi

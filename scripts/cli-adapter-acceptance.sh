#!/usr/bin/env bash
# F9 CLI Adapter manual acceptance: build accp-bridge and run a one-shot
# `accp-bridge call` against a running control plane. This exercises the
# startup handshake plus one read-only tool (accp_task), proving the
# parameterized one-shot CLI path works end to end.
#
# All credentials come from the environment and are never printed here:
#   ACCP_URL              control-plane origin (e.g. http://127.0.0.1:8080)
#   ACCP_SESSION_TOKEN    delegated Session token (accp_s_...)
#   ACCP_ADAPTER_MANIFEST path to the manifest registered for this agent
#   ACCP_DEMO_TASK_ID     a readable Task id in the delegated project
#
# An optional first argument names a dotenv file to load these from; a local
# demo env (.accp-local/demo-session.env) provides all of them:
#   scripts/cli-adapter-acceptance.sh .accp-local/demo-session.env
#
# If the env is incomplete or the API is unreachable, the live call is
# skipped (exit 0) with a note; the build step always runs.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "${1:-}" ]; then
  if [ ! -f "$1" ]; then
    echo "FAIL: env file not found: $1" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$1"
  set +a
fi

echo "Building accp-bridge..."
go build -o bin/accp-bridge ./cmd/accp-bridge/
echo "PASS: accp-bridge build"

missing=()
for v in ACCP_URL ACCP_SESSION_TOKEN ACCP_ADAPTER_MANIFEST ACCP_DEMO_TASK_ID; do
  if [ -z "${!v:-}" ]; then missing+=("$v"); fi
done
if [ "${#missing[@]}" -ne 0 ]; then
  echo "SKIP: live acceptance (missing: ${missing[*]}). Build verified only." >&2
  exit 0
fi

# Probe reachability without leaking the token; /healthz is unauthenticated.
if ! curl -fsS -m 3 "${ACCP_URL%/}/healthz" >/dev/null 2>&1; then
  echo "SKIP: control plane at ${ACCP_URL} is unreachable. Build verified only." >&2
  exit 0
fi

echo "Running one-shot handshake + accp_task (read-only)..."
if printf '{"id":"%s"}' "$ACCP_DEMO_TASK_ID" | bin/accp-bridge call accp_task; then
  echo "PASS: CLI Adapter one-shot handshake + accp_task"
  exit 0
else
  echo "FAIL: CLI Adapter one-shot acceptance" >&2
  exit 1
fi

#!/bin/sh
set -eu
export DATABASE_URL="$(cat /run/secrets/database_url)"
exec /bench "$@"

#!/bin/sh
set -eu
if [ -f /sys/fs/cgroup/cpu.max ]; then
  set -- $(cat /sys/fs/cgroup/cpu.max) "$@"
  quota=$1; period=$2; shift 2
  memory=$(cat /sys/fs/cgroup/memory.max)
else
  quota=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us)
  period=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)
  memory=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
fi
case "$quota:$period:$memory" in *[!0-9:]*|'') echo 'Capacity limits are not enforced' >&2; exit 1;; esac
if [ "$quota" -ne "$((period * 4))" ] || [ "$memory" -ne 4294967296 ]; then
  echo 'Benchmark requires enforced 4 CPU / 4 GiB limits' >&2
  exit 1
fi
export DATABASE_URL="$(cat /run/secrets/database_url)"
exec /bench "$@"

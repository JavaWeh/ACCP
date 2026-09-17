import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function validateLimits(host, controller, cpus, memoryGiB) {
  const configured =
    host.NanoCpus > 0
      ? host.NanoCpus / 1e9
      : host.CpuQuota > 0 && host.CpuPeriod > 0
        ? host.CpuQuota / host.CpuPeriod
        : 0;
  const [quota, period, memory] = controller.trim().split(/\s+/).map(Number);
  if (
    configured !== cpus ||
    host.Memory !== memoryGiB * 2 ** 30 ||
    !Number.isFinite(quota) ||
    quota <= 0 ||
    period <= 0 ||
    quota / period !== cpus ||
    memory !== memoryGiB * 2 ** 30
  ) {
    throw new Error(
      `Resource limits are not enforced: expected ${cpus} CPU / ${memoryGiB} GiB`,
    );
  }
  return { cpus, memory_gib: memoryGiB, quota, period, enforced: true };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const names = process.argv.slice(2);
  if (
    names.length !== 2 ||
    names.some((name) => !/^accp-capacity-[a-z0-9-]+$/.test(name))
  )
    throw new Error(
      "Pass the isolated capacity PostgreSQL and NATS container names",
    );
  const result = [];
  for (const [i, name] of names.entries()) {
    const host = JSON.parse(
      execFileSync(
        "docker",
        ["inspect", name, "--format", "{{json .HostConfig}}"],
        { encoding: "utf8" },
      ),
    );
    const controller = execFileSync(
      "docker",
      [
        "exec",
        name,
        "sh",
        "-ec",
        "if [ -f /sys/fs/cgroup/cpu.max ]; then cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max; else cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu/cpu.cfs_period_us /sys/fs/cgroup/memory/memory.limit_in_bytes; fi",
      ],
      { encoding: "utf8" },
    );
    result.push({
      container: name,
      ...validateLimits(host, controller, i === 0 ? 3 : 1, i === 0 ? 10 : 2),
    });
  }
  console.log(
    JSON.stringify({ checked_at: new Date().toISOString(), services: result }),
  );
}

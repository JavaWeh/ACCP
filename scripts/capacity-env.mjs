import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
const directory = resolve(process.argv[2] || ".accp-local/capacity-baseline");
if (!directory.includes(".accp-local"))
  throw new Error("Use an isolated .accp-local directory");
mkdirSync(directory, { recursive: true });
const password = randomBytes(32).toString("hex");
writeFileSync(resolve(directory, "password"), password, {
  mode: 0o600,
  flag: "wx",
});
writeFileSync(
  resolve(directory, "database-url"),
  `postgres://capacity:${password}@postgres:5432/accp_capacity?sslmode=disable`,
  { mode: 0o600, flag: "wx" },
);
writeFileSync(
  resolve(directory, "compose.env"),
  `ACCP_CAPACITY_DIR=${directory.replaceAll("\\", "/")}\nACCP_BENCH_IMAGE=accp:bench-baseline\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created isolated capacity configuration; no database or credentials exposed.",
);

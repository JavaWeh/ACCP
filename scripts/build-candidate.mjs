import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
const version = process.argv[2];
if (!/^v\d+\.\d+\.\d+-rc\.\d+$/.test(version || ""))
  throw new Error(
    "An explicit vX.Y.Z-rc.N version is required; formal releases are rejected",
  );
const output = resolve(process.argv[3] || `.accp-local/releases/${version}`);
mkdirSync(output, { recursive: true });
const go = process.env.ACCP_GO || "go";
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty = !!execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=normal"],
  { encoding: "utf8" },
).trim();
const builtAt = new Date().toISOString();
const ldflags = `-s -w -X github.com/JavaWeh/ACCP/internal/buildinfo.Version=${version} -X github.com/JavaWeh/ACCP/internal/buildinfo.Revision=${revision}${dirty ? "-dirty" : ""} -X github.com/JavaWeh/ACCP/internal/buildinfo.BuiltAt=${builtAt}`;
const target = process.env.ACCP_TARGET;
const targets = target
  ? [target]
  : [
      "windows/amd64",
      "linux/amd64",
      "linux/arm64",
      "darwin/amd64",
      "darwin/arm64",
    ];
for (const platform of targets) {
  if (
    ![
      "windows/amd64",
      "linux/amd64",
      "linux/arm64",
      "darwin/amd64",
      "darwin/arm64",
    ].includes(platform)
  )
    throw new Error("Unsupported target");
  const [os, arch] = platform.split("/");
  const name = `accp-bridge-${version}-${os}-${arch}`;
  const directory = join(output, name);
  mkdirSync(directory, { recursive: true });
  const binary = join(
    directory,
    "accp-bridge" + (os === "windows" ? ".exe" : ""),
  );
  execFileSync(
    go,
    [
      "build",
      "-trimpath",
      "-ldflags",
      ldflags,
      "-o",
      binary,
      "./cmd/accp-bridge",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch },
    },
  );
  cpSync("LICENSE", join(directory, "LICENSE"));
  cpSync(
    "contracts/examples/valid/m2-manifest.json",
    join(directory, "adapter-manifest.example.json"),
  );
  writeFileSync(
    join(directory, "compatibility.json"),
    JSON.stringify(
      { version, revision, dirty, rest: "/api/v1", adapter: "0.2", os, arch },
      null,
      2,
    ),
  );
  const hostOS = process.platform === "win32" ? "windows" : process.platform;
  const hostArch = process.arch === "x64" ? "amd64" : process.arch;
  if (hostOS === os && hostArch === arch) {
    const result = JSON.parse(
      execFileSync(binary, ["--version"], { encoding: "utf8" }),
    );
    if (result.version !== version || result.arch !== arch)
      throw new Error("Native startup metadata mismatch");
    writeFileSync(
      join(directory, "startup.json"),
      JSON.stringify(result, null, 2),
    );
  }
  execFileSync("tar", [
    "-czf",
    join(output, name + ".tar.gz"),
    "-C",
    output,
    name,
  ]);
}
if (!target) {
  const bundle = join(output, `accp-install-${version}`);
  mkdirSync(bundle, { recursive: true });
  for (const p of [
    "deploy/production",
    "deploy/acceptance",
    "internal/database/migrations",
    "docs",
    "README.md",
    "LICENSE",
    "contracts",
    "scripts/production-env.mjs",
    "scripts/adopt-production.mjs",
    "scripts/rotate-production.mjs",
    "scripts/hourly-backup.mjs",
  ]) {
    cpSync(p, join(bundle, p), { recursive: true });
  }
  writeFileSync(
    join(bundle, "release.json"),
    JSON.stringify(
      { version, revision, dirty, builtAt, forwardMigrationsOnly: true },
      null,
      2,
    ),
  );
  execFileSync("tar", [
    "-czf",
    join(output, `accp-install-${version}.tar.gz`),
    "-C",
    output,
    `accp-install-${version}`,
  ]);
}
// Go dependency inventory is a CycloneDX SBOM; Web and images have separate inventories.
const modules = execFileSync(go, ["list", "-m", "-json", "all"], {
  encoding: "utf8",
})
  .trim()
  .split(/}\s*\n(?={)/)
  .map((s, i, a) => JSON.parse(i < a.length - 1 ? s + "}" : s));
writeFileSync(
  join(output, "go.cdx.json"),
  JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        timestamp: builtAt,
        component: { type: "application", name: "ACCP", version },
      },
      components: modules.map((m) => ({
        type: "library",
        name: m.Path,
        version: m.Version || version,
        purl: `pkg:golang/${m.Path}@${m.Version || version}`,
      })),
    },
    null,
    2,
  ),
);
writeFileSync(
  join(output, "release.json"),
  JSON.stringify(
    { version, revision, dirty, builtAt, targets, candidateOnly: true },
    null,
    2,
  ),
);
const files = readdirSync(output).filter((f) => /\.(tar\.gz|json)$/.test(f));
writeFileSync(
  join(output, "SHA256SUMS"),
  files
    .sort()
    .map(
      (f) =>
        createHash("sha256")
          .update(readFileSync(join(output, f)))
          .digest("hex") +
        "  " +
        f,
    )
    .join("\n") + "\n",
);
console.log(JSON.stringify({ version, revision, dirty, output, targets }));

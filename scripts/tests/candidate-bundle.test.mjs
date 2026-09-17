import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checker = resolve("scripts/check-candidate-bundle.mjs");
const fixture = (t, source = "../../configs/nats.conf") => {
  const root = mkdtempSync(join(tmpdir(), "accp-candidate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "deploy/production"), { recursive: true });
  mkdirSync(join(root, "deploy/acceptance"), { recursive: true });
  mkdirSync(join(root, "configs"), { recursive: true });
  writeFileSync(
    join(root, "deploy/production/compose.yaml"),
    `services:\n  nats:\n    volumes:\n      - '${source}:/etc/nats/accp.conf:ro'\n      - 'events:/data'\n      - '\${ACCP_DEPLOY_DIR}/tls:/tls:ro'\n`,
  );
  writeFileSync(
    join(root, "deploy/acceptance/compose.yaml"),
    "services:\n  caddy:\n    volumes:\n      - '../acceptance/Caddyfile:/etc/caddy/Caddyfile:ro'\n",
  );
  writeFileSync(join(root, "deploy/acceptance/Caddyfile"), "localhost\n");
  return root;
};
const check = (root) =>
  spawnSync(process.execPath, [checker, root], { encoding: "utf8" });

test("candidate bundle resolves overlay binds from the primary Compose file", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "configs/nats.conf"), "jetstream {}\n");
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified: 2/);
});
test("candidate bundle rejects a missing required NATS configuration", (t) => {
  const result = check(fixture(t));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
});
test("candidate bundle rejects Docker-created directories in place of files", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "configs/nats.conf"));
  const result = check(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a file/);
});
test("candidate bundle rejects a bind source outside the installation", (t) => {
  const result = check(fixture(t, "../../../outside.conf"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /escapes candidate bundle/);
});

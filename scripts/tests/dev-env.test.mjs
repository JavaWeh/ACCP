import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../dev-env.mjs', import.meta.url));

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'accp-dev-env-'));
  t.after(() => {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(`${parent}${sep}accp-dev-env-`));
    rmSync(absolute, { recursive: true, force: true });
  });
  const path = join(root, '.accp-local', 'compose.env');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  const read = () => Object.fromEntries(readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  return { root, path, run, read };
}

function assertSafeToken(values, output) {
  // Keep all 32 random bytes, with an unambiguous string prefix for NATS.
  assert.match(values.ACCP_NATS_TOKEN, /^accp_[a-f0-9]{64}$/);
  assert.ok(!output.includes(values.ACCP_NATS_TOKEN));
}

test('fresh development config uses a NATS-safe token and refuses overwrite', (t) => {
  const { path, run, read } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assertSafeToken(read(), result.stdout + result.stderr);
  const original = readFileSync(path, 'utf8');
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('upgrade adds a NATS-safe token while preserving existing credentials', (t) => {
  const { root, path, run, read } = fixture(t);
  mkdirSync(join(root, '.accp-local'));
  writeFileSync(path, 'ACCP_ENV=development\nPOSTGRES_PASSWORD=fixture-password\nACCP_SESSION_KEY=fixture-session\n');
  const result = run('--upgrade-m2');
  assert.equal(result.status, 0, result.stderr);
  const values = read();
  assertSafeToken(values, result.stdout + result.stderr);
  assert.equal(values.POSTGRES_PASSWORD, 'fixture-password');
  assert.equal(values.ACCP_SESSION_KEY, 'fixture-session');
});

test('upgrade does not silently rotate an existing NATS token', (t) => {
  const { root, path, run, read } = fixture(t);
  mkdirSync(join(root, '.accp-local'));
  writeFileSync(path, 'ACCP_ENV=development\nACCP_NATS_TOKEN=existing-fixture-token\n');
  const result = run('--upgrade-m2');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read().ACCP_NATS_TOKEN, 'existing-fixture-token');
});

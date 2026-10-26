import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  BRIDGE_TARGETS,
  archiveFileName,
  formatSha256Sums,
  parsePackageArgs,
  packageBridge,
  sha256Hex,
  buildStoreZip,
  buildUstarTar,
} from '../package-bridge.mjs';

function tempOut(t) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'accp-package-bridge-'));
  t.after(() => {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(`${parent}${sep}accp-package-bridge-`));
    rmSync(absolute, { recursive: true, force: true });
  });
  return root;
}

test('archive naming covers required GOOS/GOARCH matrix', () => {
  const version = 'v0.1.0-rc.1';
  const names = BRIDGE_TARGETS.map((t) => archiveFileName(version, t));
  assert.deepEqual(names, [
    'accp-bridge-v0.1.0-rc.1-linux-amd64.tar.gz',
    'accp-bridge-v0.1.0-rc.1-linux-arm64.tar.gz',
    'accp-bridge-v0.1.0-rc.1-darwin-amd64.tar.gz',
    'accp-bridge-v0.1.0-rc.1-darwin-arm64.tar.gz',
    'accp-bridge-v0.1.0-rc.1-windows-amd64.zip',
  ]);
});

test('SHA256SUMS format uses hash, two spaces, filename', () => {
  const text = formatSha256Sums([
    { name: 'a.tar.gz', hash: 'abc' },
    { name: 'b.zip', hash: 'def' },
  ]);
  assert.equal(text, 'abc  a.tar.gz\ndef  b.zip\n');
});

test('parsePackageArgs requires out and version', () => {
  assert.throws(() => parsePackageArgs([]), /Usage/);
  assert.deepEqual(parsePackageArgs(['--out', 'out', '--version', 'v1']), {
    out: 'out',
    version: 'v1',
    skipCompile: false,
    prebuiltDir: '',
    help: false,
  });
});

test('ustar and zip helpers produce non-empty archives', () => {
  const payload = Buffer.from('accp-bridge-fixture');
  const tar = buildUstarTar('accp-bridge', payload);
  assert.ok(tar.length >= 512 + payload.length);
  const zip = buildStoreZip('accp-bridge.exe', payload);
  assert.ok(zip.length > payload.length);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
});

test('packageBridge --skip-compile writes archives and matching SHA256SUMS', async (t) => {
  const out = tempOut(t);
  const binaries = Object.fromEntries(
    BRIDGE_TARGETS.map((target) => [`${target.goos}-${target.goarch}`, Buffer.from(`bin-${target.goos}-${target.goarch}`)]),
  );
  const result = await packageBridge({
    repoRoot: out,
    outDir: out,
    version: 'v0.1.0-rc.1',
    skipCompile: true,
    binaries,
  });
  assert.equal(result.archives.length, 5);
  const sums = readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
  assert.equal(sums.length, 5);
  for (const line of sums) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match, line);
    const [, hash, name] = match;
    const bytes = readFileSync(join(out, name));
    assert.equal(sha256Hex(bytes), hash);
    assert.ok(existsSync(join(out, name)));
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  REQUIRED_SECTIONS,
  parseArgs,
  parseReleaseNotes,
  reviewedAgainstPaths,
  validateReleaseNotesFile,
  checkUpgradeNotes,
} from '../check-upgrade-notes.mjs';

const script = fileURLToPath(new URL('../check-upgrade-notes.mjs', import.meta.url));

const COMPLETE_BODY = `# v0.1.0-rc.1

## Compatibility

Fresh install only.

## Migrations

none

## Grants / privileges

Apply deploy/production/grants.sql then run accp-ops check --database-url-file FILE.
Fix: docker compose -f deploy/production/compose.yaml run --rm grants

## Config / secrets / compose

none

## Breaking / operator actions

Pin digests; re-run grants after migrate.

## Reviewed-against

- docs/a.md
- docs/b.md
- docs/c.md

## Artifacts

See GitHub Release assets.
`;

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'accp-upgrade-notes-'));
  t.after(() => {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(`${parent}${sep}accp-upgrade-notes-`));
    rmSync(absolute, { recursive: true, force: true });
  });
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  return { root, put };
}

test('parseArgs accepts --version and rejects unknown flags', () => {
  assert.deepEqual(parseArgs(['--version', 'v1.0.0']), { version: 'v1.0.0', help: false });
  assert.throws(() => parseArgs(['--version']), /Usage/);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

test('parseReleaseNotes extracts title and required section bodies', () => {
  const { title, sections } = parseReleaseNotes(COMPLETE_BODY);
  assert.equal(title, 'v0.1.0-rc.1');
  for (const name of REQUIRED_SECTIONS) {
    assert.ok(sections.has(name), name);
    assert.ok(sections.get(name).trim().length > 0, name);
  }
});

test('reviewedAgainstPaths collects bullet paths', () => {
  assert.deepEqual(
    reviewedAgainstPaths('- docs/a.md\n- `docs/b.md`\n* docs/c.md\n'),
    ['docs/a.md', 'docs/b.md', 'docs/c.md'],
  );
});

test('complete notes with existing reviewed paths pass', (t) => {
  const { root, put } = fixture(t);
  put('docs/a.md', '# A\n');
  put('docs/b.md', '# B\n');
  put('docs/c.md', '# C\n');
  put('docs/releases/v0.1.0-rc.1.md', COMPLETE_BODY);
  const result = checkUpgradeNotes(root);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.checked.length, 1);
});

test('missing required section fails', (t) => {
  const { root, put } = fixture(t);
  put('docs/a.md', '# A\n');
  put('docs/b.md', '# B\n');
  put('docs/c.md', '# C\n');
  const broken = COMPLETE_BODY.replace('## Migrations\n\nnone\n\n', '');
  put('docs/releases/v0.1.0-rc.1.md', broken);
  const errors = validateReleaseNotesFile(root, join(root, 'docs/releases/v0.1.0-rc.1.md'));
  assert.ok(errors.some((e) => e.includes('Migrations')));
});

test('title mismatch and missing grants markers fail', (t) => {
  const { root, put } = fixture(t);
  put('docs/a.md', '# A\n');
  put('docs/b.md', '# B\n');
  put('docs/c.md', '# C\n');
  const badTitle = COMPLETE_BODY.replace('# v0.1.0-rc.1', '# wrong');
  put('docs/releases/v0.1.0-rc.1.md', badTitle);
  let errors = validateReleaseNotesFile(root, join(root, 'docs/releases/v0.1.0-rc.1.md'));
  assert.ok(errors.some((e) => e.includes('must match file version')));

  const noGrants = COMPLETE_BODY.replace(
    'Apply deploy/production/grants.sql then run accp-ops check --database-url-file FILE.',
    'Re-run grants somehow.',
  );
  put('docs/releases/v0.1.0-rc.1.md', noGrants);
  errors = validateReleaseNotesFile(root, join(root, 'docs/releases/v0.1.0-rc.1.md'));
  assert.ok(errors.some((e) => e.includes('grants.sql')));
  assert.ok(errors.some((e) => e.includes('accp-ops check')));
});

test('--version requires that exact file', (t) => {
  const { root, put } = fixture(t);
  put('docs/a.md', '# A\n');
  put('docs/b.md', '# B\n');
  put('docs/c.md', '# C\n');
  put('docs/releases/v0.1.0-rc.1.md', COMPLETE_BODY);
  assert.equal(checkUpgradeNotes(root, { version: 'v0.1.0-rc.1' }).ok, true);
  const missing = checkUpgradeNotes(root, { version: 'v9.9.9' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors[0].includes('Missing release notes'));
});

test('CLI exits non-zero on broken notes and zero on valid tree', (t) => {
  const { root, put } = fixture(t);
  put('docs/releases/v0.0.0.md', '# v0.0.0\n\nempty\n');
  const fail = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.notEqual(fail.status, 0);
  assert.match(fail.stderr, /Upgrade notes check failed/);

  put('docs/a.md', '# A\n');
  put('docs/b.md', '# B\n');
  put('docs/c.md', '# C\n');
  put('docs/releases/v0.1.0-rc.1.md', COMPLETE_BODY);
  rmSync(join(root, 'docs/releases/v0.0.0.md'));
  const ok = spawnSync(process.execPath, [script, '--version', 'v0.1.0-rc.1'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0, ok.stderr);
});

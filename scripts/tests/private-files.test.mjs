import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isForbiddenPath, inspectRepository } from '../check-private.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'accp-guard-'));
  t.after(() => {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(`${parent}${sep}accp-guard-`), 'cleanup stays within the generated temporary fixture');
    rmSync(absolute, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'ACCP Tooling Test');
  git('config', 'user.email', 'tooling@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  put('README.md', '# Public fixture\n');
  put('.gitignore', '.agents/\n');
  git('add', 'README.md', '.gitignore');
  git('commit', '-qm', 'Public baseline');
  return { root, git, put };
}

test('path policy handles case and Windows separators while allowing public examples', () => {
  for (const path of ['.agents/skills/internal/SKILL.md', 'nested\\Skills\\guide.txt', 'Nested/SKiLl.MD', '.env.production', 'keys/private.pem']) {
    assert.equal(isForbiddenPath(path), true, path);
  }
  for (const path of ['docs/governance.md', 'contracts/examples/valid/approval.json', '.env.example', 'LICENSE']) {
    assert.equal(isForbiddenPath(path), false, path);
  }
});

test('ignored local skills stay local and do not block public content', (t) => {
  const { root, put } = fixture(t);
  put('.agents/skills/internal/SKILL.md', 'Local-only fixture\n');
  assert.deepEqual(inspectRepository(root, true), []);
});

test('force-staged ignored skill is detected from the real index', (t) => {
  const { root, git, put } = fixture(t);
  put('.agents/skills/internal/SKILL.md', 'Local-only fixture\n');
  git('add', '-f', '.agents/skills/internal/SKILL.md');
  assert.ok(inspectRepository(root).some((entry) => entry.file.endsWith('SKILL.md')));
});

test('private file deleted in a later commit is still blocked in outgoing history', (t) => {
  const { root, git, put } = fixture(t);
  put('.agents/skills/internal/SKILL.md', 'Local-only fixture\n');
  git('add', '-f', '.agents/skills/internal/SKILL.md');
  git('commit', '-qm', 'Private fixture');
  git('rm', '.agents/skills/internal/SKILL.md');
  git('commit', '-qm', 'Remove private fixture');
  assert.deepEqual(inspectRepository(root), []);
  assert.ok(inspectRepository(root, true).some((entry) => entry.file.endsWith('SKILL.md')));
});

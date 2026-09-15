import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const privateDirectories = new Set([
  'skills', '.agents', '.claude', '.codex', '.cursor', '.gemini', '.gitnexus',
  '.accp-local', 'node_modules', 'secrets', '.npm', '.cache',
]);
const privateNames = new Set(['skill.md', 'agents.md', 'claude.md', 'gemini.md']);

export function isForbiddenPath(file) {
  const parts = file.replaceAll('\\', '/').toLowerCase().split('/');
  const name = parts.at(-1);
  return parts.some((part) => privateDirectories.has(part))
    || privateNames.has(name)
    || (name !== '.env.example' && (name === '.env' || name.startsWith('.env.')))
    || /\.(pem|key|p12|pfx|sqlite|sqlite3|db)$/.test(name)
    || /^credentials.*\.json$/.test(name);
}

export function gitOutput(args, cwd = process.cwd()) {
  return execFileSync('git', [
    '-c', `core.excludesFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    ...args,
  ], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function publicFiles(cwd = process.cwd()) {
  return [...new Set(gitOutput(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd)
    .split('\0').filter(Boolean))];
}

export function inspectRepository(cwd = process.cwd(), history = false) {
  const violations = [];
  // Read the actual index: ignored paths added with -f must still fail.
  for (const file of publicFiles(cwd)) {
    if (isForbiddenPath(file)) violations.push({ location: 'index/worktree', file });
  }
  if (history) {
    if (gitOutput(['rev-parse', '--is-shallow-repository'], cwd).trim() === 'true') {
      throw new Error('History check requires a complete clone; fetch the full history first.');
    }
    const commits = gitOutput(['rev-list', 'HEAD'], cwd).trim().split('\n').filter(Boolean);
    for (const commit of commits) {
      const paths = gitOutput(['ls-tree', '-r', '--name-only', '-z', commit], cwd).split('\0').filter(Boolean);
      for (const file of paths) {
        if (isForbiddenPath(file)) violations.push({ location: commit, file });
      }
    }
  }
  return violations;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--history')) throw new Error('Usage: node scripts/check-private.mjs [--history]');
    const violations = inspectRepository(process.cwd(), args.includes('--history'));
    if (violations.length) {
      console.error('Private files must not be published:');
      for (const { location, file } of violations) console.error(`  ${location}: ${file}`);
      process.exitCode = 1;
    } else {
      console.log(`Private-path check passed (${args.includes('--history') ? 'index/worktree and all HEAD history' : 'index/worktree'}).`);
    }
  } catch (error) {
    console.error(`Private-path check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

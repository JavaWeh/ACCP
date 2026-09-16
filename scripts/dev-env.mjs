import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';

// Secrets stay in an ignored directory and never appear on stdout.
mkdirSync('.accp-local', { recursive: true });
const password = randomBytes(32).toString('hex');
const additions = {
  ACCP_SESSION_KEY: randomBytes(32).toString('hex'),
  // NATS parses environment substitutions as config values; digit prefixes can
  // be mistaken for numbers (for example, hexadecimal tokens starting in 1e).
  ACCP_NATS_TOKEN: `accp_${randomBytes(32).toString('hex')}`,
};
if (process.argv[2] === '--upgrade-m2') {
  const existing = readFileSync('.accp-local/compose.env', 'utf8');
  const values = Object.fromEntries(existing.split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  additions.ACCP_PUBLIC_URL = `http://127.0.0.1:${values.ACCP_HTTP_PORT || '8080'}`;
  if (values.ACCP_ENV !== 'development') throw new Error('Automatic upgrade is for explicit local development only; configure production secrets through your operator process.');
  const missing = Object.entries(additions).filter(([key]) => !(key in values));
  if (missing.length) appendFileSync('.accp-local/compose.env', '\n' + missing.map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  console.log('M2 configuration fields added when missing; existing database credentials and keys preserved.');
  process.exit(0);
}
if (process.argv.length > 2) throw new Error('Usage: node scripts/dev-env.mjs [--upgrade-m2]');
writeFileSync('.accp-local/compose.env', [
  `POSTGRES_PASSWORD=${password}`,
  'ACCP_ENV=development',
  'ACCP_AUTH_MODE=development',
  ...Object.entries(additions).map(([key, value]) => `${key}=${value}`),
  'ACCP_PUBLIC_URL=http://127.0.0.1:8080',
  `LOCAL_UID=${process.getuid?.() ?? 0}`,
  `LOCAL_GID=${process.getgid?.() ?? 0}`,
  '',
].join('\n'), { flag: 'wx', mode: 0o600 });
console.log('Created .accp-local/compose.env. Existing files are never overwritten.');

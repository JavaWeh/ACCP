import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

// Secrets stay in an ignored directory and never appear on stdout.
mkdirSync('.accp-local', { recursive: true });
const password = randomBytes(32).toString('hex');
writeFileSync('.accp-local/compose.env', [
  `POSTGRES_PASSWORD=${password}`,
  'ACCP_ENV=development',
  'ACCP_AUTH_MODE=development',
  `LOCAL_UID=${process.getuid?.() ?? 0}`,
  `LOCAL_GID=${process.getgid?.() ?? 0}`,
  '',
].join('\n'), { flag: 'wx', mode: 0o600 });
console.log('Created .accp-local/compose.env. Existing files are never overwritten.');

#!/usr/bin/env node
/**
 * TEST-ONLY: mint development_tokens for restored W0 humans that lack them.
 *
 * WP-4 / US-16 Stage G — after restore the dump has 50 human_users with
 * issuer urn:accp:development but only alice/bob rows in development_tokens.
 * There is no product CLI/OIDC path for those extras (Keycloak fixture uses a
 * different issuer; direct-access grants are disabled). This script inserts
 * digests matching auth.Digest into the restored DB and writes credentials
 * under .accp-local/ only.
 *
 * NEVER use outside isolated restore drills. Does NOT change server auth code.
 * Does NOT print token values.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

function printHelp() {
  process.stdout.write(`Usage: node scripts/mint-dev-tokens-wp4-us16.mjs --isolated [options]

TEST-ONLY mint of development_tokens for urn:accp:development humans after restore.

Required:
  --isolated
  --pg-container <name>     Docker Postgres container with restored DB
  --output <path>           Credentials JSON under .accp-local/ (mode 0600)

Optional:
  --database <name>         Default accp_restore
  --retained-users <path>   Existing alice/bob tokens (source-users.json)
  --report <path>           Counts-only report JSON (no secrets)
  --ttl-hours <n>           Token TTL (default 168 = 7d)
  --help
`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    isolated: { type: 'boolean' },
    'pg-container': { type: 'string' },
    database: { type: 'string', default: 'accp_restore' },
    output: { type: 'string' },
    'retained-users': { type: 'string' },
    report: { type: 'string' },
    'ttl-hours': { type: 'string', default: '168' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  printHelp();
  process.exit(0);
}
if (!values.isolated) throw new Error('--isolated required (TEST-ONLY gate)');
if (!values['pg-container']) throw new Error('--pg-container required');
if (!values.output) throw new Error('--output required');

const outputPath = resolve(values.output);
{
  const norm = outputPath.replace(/\\/g, '/');
  if (!norm.includes('/.accp-local/') && !norm.includes('.accp-local/')) {
    throw new Error('--output must be under .accp-local/ (secrets must stay untracked)');
  }
}

const pgContainer = values['pg-container'];
const database = values.database || 'accp_restore';
const ttlHours = Math.max(1, Math.min(720, Number.parseInt(values['ttl-hours'], 10) || 168));
const reportPath = values.report ? resolve(values.report) : null;
const retainedPath = values['retained-users'] ? resolve(values['retained-users']) : null;

function digest(token) {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function mintToken() {
  return randomBytes(32).toString('base64url');
}

function docker(args, opts = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (opts.allowFail) return result;
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 5).join(' ')} failed: ${(result.stderr || result.stdout || '').slice(0, 1500)}`);
  }
  return result;
}

function psql(sql) {
  // Prefer PGOPTIONS search_path so SET does not pollute -tA row output.
  const result = docker([
    'exec', '-e', 'PGOPTIONS=-c search_path=accp', '-i', pgContainer,
    'psql', '-U', 'accp', '-d', database, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql,
  ]);
  return (result.stdout || '').trim();
}

const humansRaw = psql(
  "SELECT id || E'\\t' || issuer || E'\\t' || subject FROM human_users WHERE issuer = 'urn:accp:development' ORDER BY id;",
);
const humans = humansRaw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && line.includes('\t') && !/^(SET|INSERT|SELECT)/i.test(line))
  .map((line) => {
    const [id, issuer, subject] = line.split('\t');
    if (!id || !issuer || !subject) throw new Error(`bad human row: ${line.slice(0, 80)}`);
    return { id, issuer, subject };
  });

if (humans.length === 0) throw new Error('no urn:accp:development humans in restored DB');

const retained = [];
if (retainedPath && existsSync(retainedPath)) {
  const parsed = JSON.parse(readFileSync(retainedPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('retained-users must be a JSON array');
  for (const entry of parsed) {
    if (entry?.user_id && entry?.token) retained.push(entry);
  }
}
const retainedById = new Map(retained.map((e) => [e.user_id, e]));

const credentials = [];
const mintedIds = [];
const reusedIds = [];
const expiry = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

for (const human of humans) {
  const existing = retainedById.get(human.id);
  if (existing?.token) {
    // Verify retained token still authenticates against restored digests.
    const dig = digest(existing.token);
    const ok = psql(
      `SELECT count(*) FROM development_tokens WHERE digest = '${dig}' AND expires_at > now();`,
    );
    if (ok === '1') {
      credentials.push({
        user_id: human.id,
        issuer: human.issuer,
        subject: human.subject,
        token: existing.token,
        expires_at: existing.expires_at || expiry,
        source: 'retained',
      });
      reusedIds.push(human.id);
      continue;
    }
  }

  const token = mintToken();
  const dig = digest(token);
  // Escape single quotes for SQL literals (subjects are controlled seed values).
  const esc = (s) => String(s).replace(/'/g, "''");
  psql(
    `INSERT INTO development_tokens(digest, issuer, subject, expires_at) VALUES ('${esc(dig)}', '${esc(human.issuer)}', '${esc(human.subject)}', '${esc(expiry)}');`,
  );
  credentials.push({
    user_id: human.id,
    issuer: human.issuer,
    subject: human.subject,
    token,
    expires_at: expiry,
    source: 'minted',
  });
  mintedIds.push(human.id);
}

const tokenCount = psql('SELECT count(*) FROM development_tokens;');

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(
  outputPath,
  JSON.stringify(credentials.map(({ user_id, token, expires_at }) => ({ user_id, token, expires_at }))) + '\n',
  { mode: 0o600 },
);

const report = {
  test_only: true,
  purpose: 'WP-4 US-16 Stage G post-restore development_token mint',
  at: new Date().toISOString(),
  pg_container: pgContainer,
  database,
  human_users_development: humans.length,
  credentials_written: credentials.length,
  minted_count: mintedIds.length,
  reused_retained_count: reusedIds.length,
  development_tokens_rows_after: Number.parseInt(tokenCount, 10) || null,
  minted_user_ids: mintedIds,
  reused_user_ids: reusedIds,
  output_path: outputPath.replace(/\\/g, '/').includes('.accp-local/')
    ? join('.accp-local', ...outputPath.replace(/\\/g, '/').split('.accp-local/')[1].split('/'))
    : '(under .accp-local)',
  note: 'Token values written only to --output (mode 0600). Not printed. Not a production auth bypass.',
};

if (reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}

// stdout: counts only — never tokens
process.stdout.write(JSON.stringify({
  ok: credentials.length === humans.length,
  human_users: humans.length,
  credentials: credentials.length,
  minted: mintedIds.length,
  reused: reusedIds.length,
  development_tokens_rows: Number.parseInt(tokenCount, 10) || null,
  report: reportPath || null,
  output: '(redacted path under .accp-local)',
}) + '\n');

if (credentials.length !== humans.length) process.exit(1);

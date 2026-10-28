#!/usr/bin/env node
/**
 * Prepare an isolated W0-scale Postgres source for WP-4 / US-16 restore drill.
 *
 * No product code changes: migrate + bootstrap -development, then seed via
 * existing management/task/agent-session APIs (same patterns as loadtest-w0.mjs).
 *
 * Honesty: only alice/bob receive development_tokens. Extra humans are real
 * human_users (+ memberships) rows with issuer urn:accp:development, but are
 * not loginable under development auth. Prefer Bob/Alice for post-restore probes.
 *
 * Does NOT run backup / interrupt / restore — Stage C uses --source-database-url-file.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

function printHelp() {
  const text = `Usage: node scripts/prepare-w0-restore-source.mjs --isolated [options]

Prepare a digest-compatible W0-ish source DB for restore-drill-w0.mjs
(--source-database-url-file). Leaves Postgres running; stops the temporary API.

Required:
  --isolated                         Explicit acceptance (isolated drill seed)
  --directory <path>                 Evidence dir (e.g. .accp-local/wp4-us16-restore-drill)
  --network <name>                   Docker network (e.g. accp-restore-drill)
  --app-image <ref>                  App image for migrate/bootstrap/serve (e.g. accp:local)

Optional:
  --humans <n>                       Target human_users rows (default 50, min 2)
  --agent-sessions <n>               Target agent_sessions rows (default 200)
  --tasks <n>                        Representative tasks to create (default 25)
  --postgres-image <ref>             Default postgres:17
  --api-port <n>                     Host loopback port for temporary API (default 18081)
  --cleanup                          Remove source Postgres + written URL file and exit
  --dry-verify                       Confirm docker/network/image only; no containers
  --help                             Show this help

Outputs under --directory:
  source-database-url-file           postgres URL (search_path=accp) for Stage C
  seed-manifest.json                 counts, honesty, container name, digests
  source-users.json                  alice/bob development credentials only
  prepare-journal.jsonl             phase log
`;
  process.stdout.write(text);
}

const argvHelp = process.argv.includes('--help') || process.argv.includes('-h');
if (argvHelp) {
  printHelp();
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    isolated: { type: 'boolean' },
    directory: { type: 'string' },
    network: { type: 'string' },
    'app-image': { type: 'string' },
    humans: { type: 'string', default: '50' },
    'agent-sessions': { type: 'string', default: '200' },
    tasks: { type: 'string', default: '25' },
    'postgres-image': { type: 'string', default: 'postgres:17' },
    'api-port': { type: 'string', default: '18081' },
    cleanup: { type: 'boolean', default: false },
    'dry-verify': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  printHelp();
  process.exit(0);
}
if (!values.isolated) throw new Error('--isolated required');
for (const name of ['directory', 'network', 'app-image']) {
  if (!values[name]) throw new Error(`--${name} required`);
}

const directory = resolve(values.directory);
const network = values.network;
const appImage = values['app-image'];
const postgresImage = values['postgres-image'];
const humansTarget = Math.max(2, Number.parseInt(values.humans, 10) || 50);
const sessionsTarget = Math.max(0, Math.min(500, Number.parseInt(values['agent-sessions'], 10) || 200));
const tasksTarget = Math.max(0, Math.min(200, Number.parseInt(values.tasks, 10) || 25));
const apiPort = Math.max(1024, Math.min(65535, Number.parseInt(values['api-port'], 10) || 18081));
const prepareId = randomUUID();
const password = randomUUID().replace(/-/g, '');
const sourceContainer = `accp-wp4-us16-source-${prepareId.slice(0, 8)}`;
const apiContainer = `accp-wp4-us16-api-${prepareId.slice(0, 8)}`;
const urlFile = join(directory, 'source-database-url-file');
const manifestPath = join(directory, 'seed-manifest.json');
const credPath = join(directory, 'source-users.json');
const journalPath = join(directory, 'prepare-journal.jsonl');
const sessionKey = randomBytes(32).toString('hex');

const sleepMs = (ms) => {
  spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${Math.max(0, ms | 0)})`], { windowsHide: true });
};

const docker = (args, opts = {}) => {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: opts.timeout ?? 10 * 60 * 1000,
  });
  if (opts.allowFail) return result;
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || '').slice(0, 1200)}`);
  }
  return result;
};

const journal = (phase, extra = {}) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ at: new Date().toISOString(), phase, prepare_id: prepareId, ...extra }) + '\n';
  const fd = openSync(journalPath, 'a', 0o600);
  try {
    writeFileSync(fd, line);
  } finally {
    closeSync(fd);
  }
};

function imageDigestRef(tag) {
  const id = docker(['image', 'inspect', tag, '--format', '{{.Id}}']).stdout.trim();
  if (!id.startsWith('sha256:')) throw new Error(`unexpected image id for ${tag}: ${id}`);
  // Prefer RepoDigests when present (pushed images); else tag@image-id (accepted by backup: contains sha256:).
  const digests = docker(['image', 'inspect', tag, '--format', '{{json .RepoDigests}}']).stdout.trim();
  let repo = [];
  try { repo = JSON.parse(digests) || []; } catch { repo = []; }
  if (repo.length && String(repo[0]).includes('sha256:')) return String(repo[0]);
  return `${tag}@${id}`;
}

function ensureNetwork() {
  const listed = docker(['network', 'ls', '--format', '{{.Name}}']).stdout.split(/\r?\n/).map((s) => s.trim());
  if (!listed.includes(network)) {
    throw new Error(`docker network ${network} not found; create with: docker network create ${network}`);
  }
}

function waitReady(container, db = 'accp_source') {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const ready = docker(['exec', container, 'pg_isready', '-U', 'accp', '-d', db], { allowFail: true });
    if (ready.status === 0) return;
    sleepMs(1000);
  }
  throw new Error(`postgres ${container} not ready`);
}

function waitAPI(originURL) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const probe = spawnSync(process.execPath, ['-e', `
      fetch(${JSON.stringify(originURL + '/healthz')}, { signal: AbortSignal.timeout(2000) })
        .then((r) => process.exit(r.ok ? 0 : 1))
        .catch(() => process.exit(1));
    `], { windowsHide: true, encoding: 'utf8' });
    if (probe.status === 0) return;
    sleepMs(1000);
  }
  throw new Error(`API at ${originURL} not ready`);
}

let origin = '';

async function api(token, method, path, body, { status = 200, version } = {}) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (method === 'POST') headers['Idempotency-Key'] = randomUUID();
  if (version) headers['If-Match'] = `"${version}"`;
  const res = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status !== status) {
    throw new Error(`${method} ${path}: ${res.status} ${data?.code || 'unexpected'}, trace ${data?.trace_id || 'unknown'}`);
  }
  return data;
}

function countRows(container, table) {
  const q = `SELECT count(*) FROM accp.${table}`;
  const out = docker([
    'exec', '-u', 'postgres', container,
    'psql', '-U', 'accp', '-d', 'accp_source', '-At', '-c', q,
  ]).stdout.trim();
  return Number.parseInt(out, 10) || 0;
}

if (values['dry-verify']) {
  ensureNetwork();
  const appDigest = imageDigestRef(appImage);
  let opsDigest = null;
  try { opsDigest = imageDigestRef('accp-ops:m3-local'); } catch { opsDigest = 'accp-ops:m3-local not inspected'; }
  const payload = {
    ok: true,
    network,
    app_image: appImage,
    app_digest_ref: appDigest,
    ops_digest_ref: opsDigest,
    note: 'dry-verify only; no source DB started',
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(0);
}

mkdirSync(directory, { recursive: true, mode: 0o700 });

if (values.cleanup) {
  if (existsSync(manifestPath)) {
    const prior = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (prior.source_container) docker(['rm', '-f', prior.source_container], { allowFail: true });
    if (prior.api_container) docker(['rm', '-f', prior.api_container], { allowFail: true });
    if (prior.api_container_stopped) docker(['rm', '-f', prior.api_container_stopped], { allowFail: true });
  }
  docker(['rm', '-f', sourceContainer], { allowFail: true });
  docker(['rm', '-f', apiContainer], { allowFail: true });
  journal('CLEANUP');
  process.stdout.write(JSON.stringify({ cleaned: true, directory }, null, 2) + '\n');
  process.exit(0);
}

ensureNetwork();
const appDigestRef = imageDigestRef(appImage);
journal('STARTED', { humansTarget, sessionsTarget, tasksTarget, appDigestRef });

// Remove stale containers from a previous prepare in this directory.
if (existsSync(manifestPath)) {
  try {
    const prior = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (prior.source_container) docker(['rm', '-f', prior.source_container], { allowFail: true });
    if (prior.api_container) docker(['rm', '-f', prior.api_container], { allowFail: true });
    if (prior.api_container_stopped) docker(['rm', '-f', prior.api_container_stopped], { allowFail: true });
  } catch { /* ignore */ }
}

docker(['rm', '-f', sourceContainer], { allowFail: true });
docker([
  'run', '-d', '--name', sourceContainer, '--network', network,
  '-e', `POSTGRES_PASSWORD=${password}`,
  '-e', 'POSTGRES_USER=accp',
  '-e', 'POSTGRES_DB=accp_source',
  postgresImage,
]);
waitReady(sourceContainer, 'accp_source');
docker(['exec', '-u', 'postgres', sourceContainer, 'psql', '-U', 'accp', '-d', 'accp_source', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE SCHEMA IF NOT EXISTS accp;']);
docker([
  'exec', '-u', 'postgres', sourceContainer,
  'psql', '-U', 'accp', '-d', 'accp_source', '-v', 'ON_ERROR_STOP=1',
  '-c', 'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA accp;',
]);
journal('SOURCE_READY', { container: sourceContainer });

const sourceURL = `postgres://accp:${password}@${sourceContainer}:5432/accp_source?sslmode=disable&options=-csearch_path%3Daccp`;
writeFileSync(urlFile, sourceURL + '\n', { mode: 0o600 });

docker([
  'run', '--rm', '--network', network,
  '-e', `DATABASE_URL=${sourceURL}`,
  appImage, 'migrate',
]);
journal('MIGRATED');

if (existsSync(credPath)) unlinkSync(credPath);
docker([
  'run', '--rm', '--network', network,
  '-e', `DATABASE_URL=${sourceURL}`,
  '-e', 'ACCP_ENV=development',
  '-e', 'ACCP_AUTH_MODE=development',
  '--mount', `type=bind,source=${directory},target=/local`,
  appImage,
  'bootstrap', '-development', '-output', '/local/source-users.json',
]);
journal('BOOTSTRAPPED', { credentials: 'source-users.json' });

const credentials = JSON.parse(readFileSync(credPath, 'utf8'));
const alice = credentials.find((e) => e.user_id === 'user_alice')?.token;
const bob = credentials.find((e) => e.user_id === 'user_bob')?.token;
if (!alice || !bob) throw new Error('bootstrap did not return alice/bob development tokens');

origin = `http://127.0.0.1:${apiPort}`;
docker(['rm', '-f', apiContainer], { allowFail: true });
docker([
  'run', '-d', '--name', apiContainer, '--network', network,
  '-p', `127.0.0.1:${apiPort}:8080`,
  '-e', `DATABASE_URL=${sourceURL}`,
  '-e', 'ACCP_ENV=development',
  '-e', 'ACCP_AUTH_MODE=development',
  '-e', 'ACCP_LISTEN_ADDR=0.0.0.0:8080',
  '-e', `ACCP_PUBLIC_URL=${origin}`,
  '-e', `ACCP_SESSION_KEY=${sessionKey}`,
  '-e', 'ACCP_DATABASE_MAX_CONNS=40',
  appImage, 'serve',
]);
waitAPI(origin);
journal('API_READY', { origin, container: apiContainer });

const project = 'project_demo';
const manifest = {
  adapter_id: 'accp_restore_seed',
  adapter_version: '0.1.0',
  protocol_versions: ['0.2'],
  client: { name: 'w0-restore-seed', version: '0.1.0' },
  capabilities: {
    claim: true, context_read: true, artifact_report: true, heartbeat: true,
    cancel: 'cooperative', notifications: ['poll'], auto_start: false,
  },
};
const sessionScopes = ['tasks:read', 'runs:claim', 'runs:write', 'context:read', 'artifacts:write', 'events:read'];

const humanErrors = [];
const createdHumans = [];
const extraNeeded = Math.max(0, humansTarget - 2);
for (let i = 0; i < extraNeeded; i++) {
  const n = String(i + 1).padStart(3, '0');
  const subject = `restore_seed_${n}`;
  try {
    const human = await api(alice, 'POST', '/organization/members', {
      issuer: 'urn:accp:development',
      subject,
      display_name: `Restore Seed ${n}`,
      reason: 'WP-4 US-16 W0 restore source seed',
    }, { status: 201 });
    await api(alice, 'POST', `/projects/${project}/members`, {
      user_id: human.id,
      roles: ['MEMBER'],
      reason: 'WP-4 US-16 project membership for dump volume',
    }, { status: 201 });
    createdHumans.push({ id: human.id, subject });
  } catch (error) {
    humanErrors.push(String(error));
  }
}
journal('HUMANS_SEEDED', { created: createdHumans.length, errors: humanErrors.length });

const taskErrors = [];
const createdTasks = [];
let sharedVersionId = null;
if (tasksTarget > 0) {
  try {
    const content = await api(bob, 'POST', `/projects/${project}/contents`, {
      content: `WP-4 restore seed context ${randomUUID()}`,
      media_type: 'text/plain',
    }, { status: 201 });
    const context = await api(bob, 'POST', `/projects/${project}/contexts`, {
      name: `WP-4 restore seed ${randomUUID().slice(0, 8)}`,
      type: 'REQUIREMENT',
      source: { kind: 'ACCP', canonical_uri: `urn:accp:restore-seed:${randomUUID()}` },
    }, { status: 201 });
    const version = await api(bob, 'POST', `/contexts/${context.id}/versions`, {
      source_revision: '1',
      content_uri: content.content_uri,
      content_digest: content.content_digest,
      media_type: content.media_type,
      change_summary: 'WP-4 restore seed',
    }, { version: context.version, status: 201 });
    await api(bob, 'POST', `/contexts/${context.id}/versions/${version.id}/publish`, {}, {
      version: version.version,
    });
    sharedVersionId = version.id;
  } catch (error) {
    taskErrors.push(`context setup: ${error}`);
  }
}
if (sharedVersionId) {
  for (let i = 0; i < tasksTarget; i++) {
    try {
      const task = await api(bob, 'POST', `/projects/${project}/tasks`, {
        title: `WP-4 restore seed task ${i + 1}`,
        objective: 'Representative task volume for W0 restore dump',
        owner_user_id: 'user_bob',
        repository_id: 'repo_demo',
        acceptance_criteria: ['Seed only; not an acceptance run'],
        context_version_ids: [sharedVersionId],
      }, { status: 201 });
      createdTasks.push(task.id);
    } catch (error) {
      taskErrors.push(String(error));
    }
  }
}
journal('TASKS_SEEDED', { created: createdTasks.length, errors: taskErrors.length });

const sessionErrors = [];
const seededSessions = [];
const batchSize = 8;
for (let i = 0; i < sessionsTarget; i += batchSize) {
  const batch = Array.from({ length: Math.min(batchSize, sessionsTarget - i) }, async () => {
    try {
      const agent = await api(bob, 'POST', '/agents', { project_id: project, manifest }, { status: 201 });
      const grant = await api(bob, 'POST', '/agent-sessions', {
        project_id: project,
        agent_id: agent.id,
        scopes: sessionScopes,
        expires_at: new Date(Date.now() + 2 * 3600000).toISOString(),
      }, { status: 201 });
      return { agent_id: agent.id, session_id: grant.session.id };
    } catch (error) {
      sessionErrors.push(String(error));
      return null;
    }
  });
  const results = await Promise.all(batch);
  for (const entry of results) {
    if (entry) seededSessions.push(entry);
  }
}
journal('SESSIONS_SEEDED', { created: seededSessions.length, errors: sessionErrors.length });

docker(['rm', '-f', apiContainer], { allowFail: true });
journal('API_STOPPED');

const counts = {
  human_users: countRows(sourceContainer, 'human_users'),
  memberships: countRows(sourceContainer, 'memberships'),
  development_tokens: countRows(sourceContainer, 'development_tokens'),
  tasks: countRows(sourceContainer, 'tasks'),
  agents: countRows(sourceContainer, 'agents'),
  agent_sessions: countRows(sourceContainer, 'agent_sessions'),
  organizations: countRows(sourceContainer, 'organizations'),
  projects: countRows(sourceContainer, 'projects'),
};

const seedManifest = {
  prepare_id: prepareId,
  prepared_at: new Date().toISOString(),
  scale: 'w0-restore-source',
  network,
  app_image: appImage,
  app_digest_ref: appDigestRef,
  postgres_image: postgresImage,
  source_container: sourceContainer,
  api_container_stopped: apiContainer,
  source_database_url_file: 'source-database-url-file',
  credentials_file: 'source-users.json',
  targets: {
    human_users: humansTarget,
    agent_sessions: sessionsTarget,
    tasks: tasksTarget,
  },
  counts,
  deltas: {
    human_users: counts.human_users - humansTarget,
    agent_sessions: counts.agent_sessions - sessionsTarget,
    tasks: counts.tasks - tasksTarget,
  },
  honesty: {
    development_login_users: ['user_alice', 'user_bob'],
    development_tokens_rows: counts.development_tokens,
    extra_humans_loginable: false,
    note: 'Extra humans are real human_users/memberships rows via POST /organization/members + project members. Only alice/bob have development_tokens; post-restore login probes must use those two. Agent sessions seeded with Bob token (same honesty as loadtest-w0).',
  },
  errors: {
    humans: humanErrors.slice(0, 10),
    tasks: taskErrors.slice(0, 10),
    sessions: sessionErrors.slice(0, 10),
  },
  stage_c_notes: {
    keep_source_running: true,
    restore_drill_flags: [
      '--isolated',
      `--directory ${directory}`,
      `--network ${network}`,
      '--ops-image accp-ops:m3-local',
      `--image ${appDigestRef}`,
      `--source-database-url-file ${urlFile}`,
    ],
    cleanup: `node scripts/prepare-w0-restore-source.mjs --isolated --directory ${directory} --network ${network} --app-image ${appImage} --cleanup`,
  },
};

writeFileSync(manifestPath, JSON.stringify(seedManifest, null, 2) + '\n', { mode: 0o600 });
journal('DONE', { counts });

process.stdout.write(JSON.stringify({
  ok: true,
  source_container: sourceContainer,
  source_database_url_file: urlFile,
  seed_manifest: manifestPath,
  counts,
  app_digest_ref: appDigestRef,
  honesty: seedManifest.honesty.note,
}, null, 2) + '\n');

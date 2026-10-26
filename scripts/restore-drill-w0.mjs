import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    directory: { type: 'string' },
    'source-database-url-file': { type: 'string' },
    'prepare-modest-source': { type: 'boolean', default: false },
    'app-image': { type: 'string' },
    'ops-image': { type: 'string' },
    image: { type: 'string' },
    network: { type: 'string' },
    actor: { type: 'string', default: 'user_alice' },
    reason: { type: 'string', default: 'W0 restore interrupt drill' },
    'interrupt-after-ms': { type: 'string', default: '1500' },
    'postgres-image': { type: 'string', default: 'postgres:17' },
    isolated: { type: 'boolean' },
  },
});

if (!values.isolated) throw new Error('--isolated required (explicit acceptance that this is an isolated drill)');
for (const name of ['directory', 'ops-image', 'image', 'network']) {
  if (!values[name]) throw new Error(`--${name} required`);
}
if (!values['prepare-modest-source'] && !values['source-database-url-file']) {
  throw new Error('Provide --source-database-url-file (accp schema) or --prepare-modest-source with --app-image');
}
if (values['prepare-modest-source'] && !values['app-image']) {
  throw new Error('--app-image required with --prepare-modest-source');
}

const directory = resolve(values.directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const interruptAfterMs = Math.max(200, Number.parseInt(values['interrupt-after-ms'], 10) || 1500);
const drillId = randomUUID();
const password = randomUUID().replace(/-/g, '');
const recipientFile = join(directory, `backup-recipient-${drillId}.txt`);
const configManifest = join(directory, `public-config-${drillId}.json`);
const backupWorkName = `backup-${drillId}.age`;
const backupFile = join(directory, `drill-${drillId}.age`);
const reportPath = join(directory, 'report.json');
const journalPath = join(directory, 'drill-journal.jsonl');
const identityMountName = `backup-identity-${drillId}`;
const createdContainers = [];

const journal = (phase, extra = {}) => {
  const line = JSON.stringify({ at: new Date().toISOString(), phase, drill_id: drillId, ...extra }) + '\n';
  const fd = openSync(journalPath, 'a', 0o600);
  try {
    writeFileSync(fd, line);
  } finally {
    closeSync(fd);
  }
};

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
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || '').slice(0, 800)}`);
  }
  return result;
};

const opsRun = (args, mounts, opts = {}) => docker([
  'run', '--rm',
  '--network', values.network,
  '--user', '65532:65532',
  '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=2g',
  ...mounts.flatMap((m) => ['--mount', m]),
  values['ops-image'],
  ...args,
], opts);

function waitReady(container, db = 'accp_restore') {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const ready = docker(['exec', container, 'pg_isready', '-U', 'accp', '-d', db], { allowFail: true });
    if (ready.status === 0) return;
    sleepMs(1000);
  }
  throw new Error(`postgres ${container} not ready`);
}

function emptyDB(name, { db = 'accp_restore', createSchema = false } = {}) {
  const container = `accp-m3-restore-${name}-${drillId.slice(0, 8)}`;
  docker(['rm', '-f', container], { allowFail: true });
  docker([
    'run', '-d', '--name', container, '--network', values.network,
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', 'POSTGRES_USER=accp',
    '-e', `POSTGRES_DB=${db}`,
    values['postgres-image'],
  ]);
  createdContainers.push(container);
  waitReady(container, db);
  if (createSchema) {
    docker(['exec', '-u', 'postgres', container, 'psql', '-U', 'accp', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE SCHEMA IF NOT EXISTS accp;']);
  }
  const url = `postgres://accp:${password}@${container}:5432/${db}?sslmode=disable&options=-csearch_path%3Daccp`;
  const urlFile = join(directory, `${name}-database-url`);
  writeFileSync(urlFile, url + '\n', { mode: 0o600 });
  return { container, urlFile, url, db };
}

function cleanupAll() {
  for (const container of createdContainers.splice(0)) {
    docker(['rm', '-f', container], { allowFail: true });
  }
}

function prepareModestSource() {
  const source = emptyDB('source', { db: 'accp_source', createSchema: true });
  journal('SOURCE_PREPARE', { container: source.container });
  // Match production initialize: extension lives in schema accp.
  docker([
    'exec', '-u', 'postgres', source.container,
    'psql', '-U', 'accp', '-d', source.db, '-v', 'ON_ERROR_STOP=1',
    '-c', 'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA accp;',
  ]);
  const migrate = docker([
    'run', '--rm', '--network', values.network,
    '-e', `DATABASE_URL=${source.url}`,
    values['app-image'], 'migrate',
  ]);
  journal('SOURCE_MIGRATE', { status: migrate.status });
  const credOut = join(directory, `source-users-${drillId}.json`);
  if (existsSync(credOut)) unlinkSync(credOut);
  docker([
    'run', '--rm', '--network', values.network,
    '-e', `DATABASE_URL=${source.url}`,
    '-e', 'ACCP_ENV=development',
    '-e', 'ACCP_AUTH_MODE=development',
    '--mount', `type=bind,source=${directory},target=/local`,
    values['app-image'],
    'bootstrap', '-development', '-output', `/local/source-users-${drillId}.json`,
  ]);
  journal('SOURCE_BOOTSTRAP', {
    credentials: `source-users-${drillId}.json`,
    note: 'kept accp.tasks_search_trgm; backup dump includes CREATE EXTENSION pg_trgm',
  });
  return source;
}

const started = new Date();
journal('STARTED');

try {
  writeFileSync(configManifest, JSON.stringify({
    drill: 'w0-restore-interrupt',
    image: values.image,
    note: 'public non-secret configuration for backup manifest',
  }, null, 2), { mode: 0o600 });

  let sourceURLFile;
  if (values['prepare-modest-source']) {
    const source = prepareModestSource();
    sourceURLFile = source.urlFile;
  } else {
    sourceURLFile = resolve(values['source-database-url-file']);
  }

  const keygen = opsRun(
    ['keygen', '--identity-file', `/work/${identityMountName}`],
    [`type=bind,source=${directory},target=/work`],
  );
  const recipient = JSON.parse(keygen.stdout).recipient;
  if (!/^age1[0-9a-z]+$/.test(recipient)) throw new Error('keygen did not return an age recipient');
  writeFileSync(recipientFile, recipient + '\n', { mode: 0o600 });
  journal('KEYGEN', { recipient_prefix: recipient.slice(0, 12) });

  const backup = opsRun(
    [
      'backup',
      '--database-url-file', '/run/db-url',
      '--recipient', recipient,
      '--config-manifest', '/run/config.json',
      '--image', values.image,
      '--output', `/work/${backupWorkName}`,
    ],
    [
      `type=bind,source=${directory},target=/work`,
      `type=bind,source=${sourceURLFile},target=/run/db-url,readonly`,
      `type=bind,source=${configManifest},target=/run/config.json,readonly`,
    ],
    { timeout: 55 * 60 * 1000 },
  );
  const produced = join(directory, backupWorkName);
  if (!existsSync(produced)) throw new Error('backup did not create encrypted archive');
  writeFileSync(backupFile, readFileSync(produced));
  unlinkSync(produced);
  const backupManifest = JSON.parse(backup.stdout);
  journal('BACKUP', { snapshot_at: backupManifest.snapshot_at, dump_sha256: backupManifest.dump_sha256 });

  const verified = opsRun(
    ['verify-backup', '--input', `/work/${backupFile.split(/[/\\]/).pop()}`, '--identity-file', `/work/${identityMountName}`],
    [`type=bind,source=${directory},target=/work`],
  );
  const verifyManifest = JSON.parse(verified.stdout);
  journal('VERIFY', { snapshot_at: verifyManifest.snapshot_at });

  const incidentAt = new Date(Date.parse(verifyManifest.snapshot_at) + 90_000).toISOString();
  const backupMountName = backupFile.split(/[/\\]/).pop();

  const first = emptyDB('first');
  journal('RESTORE_FIRST_START', { container: first.container });
  const restoreArgs = [
    'restore', '--isolated',
    '--database-url-file', '/run/target-url',
    '--input', `/work/${backupMountName}`,
    '--identity-file', `/work/${identityMountName}`,
    '--actor', values.actor,
    '--reason', values.reason,
    '--incident-at', incidentAt,
  ];
  const mounts = [
    `type=bind,source=${directory},target=/work`,
    `type=bind,source=${first.urlFile},target=/run/target-url,readonly`,
  ];
  const childName = `accp-m3-restore-run-${drillId.slice(0, 8)}`;
  docker(['rm', '-f', childName], { allowFail: true });
  const child = spawn('docker', [
    'run', '--rm', '--name', childName,
    '--network', values.network,
    '--user', '65532:65532',
    '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=2g',
    ...mounts.flatMap((m) => ['--mount', m]),
    values['ops-image'],
    ...restoreArgs,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let interrupted = false;
  const interruptTimer = setTimeout(() => {
    interrupted = true;
    spawnSync('docker', ['kill', childName], { windowsHide: true });
    try { child.kill('SIGTERM'); } catch { /* already dying */ }
  }, interruptAfterMs);

  const firstExit = await new Promise((resolvePromise) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
  clearTimeout(interruptTimer);
  journal('RESTORE_FIRST_EXIT', {
    interrupted,
    code: firstExit.code,
    signal: firstExit.signal,
    stderr_tail: (firstExit.stderr || '').slice(-400),
  });
  docker(['rm', '-f', first.container], { allowFail: true });

  if (!interrupted && firstExit.code === 0) {
    journal('RESTORE_FIRST_TOO_FAST', { note: 'restore completed before interrupt deadline; still retrying on a new empty DB per product rule' });
  }

  const second = emptyDB('retry');
  journal('RESTORE_RETRY_START', { container: second.container });
  const retryStarted = Date.now();
  const retry = opsRun(
    [
      'restore', '--isolated',
      '--database-url-file', '/run/target-url',
      '--input', `/work/${backupMountName}`,
      '--identity-file', `/work/${identityMountName}`,
      '--actor', values.actor,
      '--reason', values.reason,
      '--incident-at', incidentAt,
    ],
    [
      `type=bind,source=${directory},target=/work`,
      `type=bind,source=${second.urlFile},target=/run/target-url,readonly`,
    ],
    { timeout: 55 * 60 * 1000 },
  );
  const restoreReport = JSON.parse(retry.stdout);
  const commandRtoObserved = (Date.now() - retryStarted) / 1000;
  journal('RESTORE_RETRY_OK', {
    rpo_seconds: restoreReport.rpo_seconds,
    rto_seconds: restoreReport.rto_seconds,
    command_wall_rto_seconds: commandRtoObserved,
  });

  const trgmCheck = docker([
    'exec', '-u', 'postgres', second.container,
    'psql', '-U', 'accp', '-d', second.db, '-v', 'ON_ERROR_STOP=1', '-tAc',
    "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'accp' AND c.relname = 'tasks_search_trgm' AND c.relkind = 'i');",
  ]);
  const trgmIndexPresent = (trgmCheck.stdout || '').trim() === 't';
  journal('TRGM_INDEX_CHECK', { present: trgmIndexPresent });
  if (!trgmIndexPresent) {
    throw new Error('accp.tasks_search_trgm missing after restore (pg_trgm extension dump/restore failed)');
  }

  const w0RpoTargetSec = 3600;
  const w0RtoTargetSec = 3600;
  const report = {
    drill_id: drillId,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    scale: 'modest-drill',
    prepared_modest_source: Boolean(values['prepare-modest-source']),
    note: 'Modest seeded source (bootstrap demo humans) — not a full 50-user W0 seed. Command RTO excludes human verification, privilege rebuild, and redeploy (see operations.md).',
    interrupted_first_attempt: interrupted || firstExit.code !== 0,
    interrupt_after_ms: interruptAfterMs,
    incident_at: incidentAt,
    snapshot_at: verifyManifest.snapshot_at,
    backup: { dump_sha256: backupManifest.dump_sha256, format: backupManifest.format },
    restore: restoreReport,
    measured: {
      rpo_seconds: restoreReport.rpo_seconds,
      command_rto_seconds: restoreReport.rto_seconds,
      command_wall_rto_seconds: commandRtoObserved,
      full_business_rto: 'not measured (human steps excluded)',
    },
    w0_targets: {
      rpo_seconds: w0RpoTargetSec,
      rto_seconds: w0RtoTargetSec,
      source: 'product-delivery-plan hourly backup RPO/RTO ≤ 1h',
    },
    met: {
      rpo: restoreReport.rpo_seconds <= w0RpoTargetSec,
      command_rto: restoreReport.rto_seconds <= w0RtoTargetSec,
      full_business_rto: null,
    },
    trgm_index_present_after_restore: trgmIndexPresent,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  journal('SUCCEEDED');

  const day = started.toISOString().slice(0, 10);
  const docPath = resolve(`docs/restore-drill-w0-${day}.md`);
  writeFileSync(docPath, [
    `# W0 restore interrupt drill (${day})`,
    '',
    `- Scale: **modest drill** (bootstrap demo seed in \`accp\` schema; not a full 50-user seed)`,
    `- Interrupted first restore: **${report.interrupted_first_attempt}**; retry on **new empty** DB (no resume into partial DB)`,
    `- Snapshot: \`${report.snapshot_at}\` · incident: \`${report.incident_at}\``,
    `- Measured RPO: **${report.measured.rpo_seconds.toFixed(3)} s** (delivery target ≤ ${w0RpoTargetSec} s) → ${report.met.rpo ? 'met' : 'not-met'}`,
    `- Measured command RTO: **${report.measured.command_rto_seconds.toFixed(3)} s** (delivery target ≤ ${w0RtoTargetSec} s) → ${report.met.command_rto ? 'met' : 'not-met'}`,
    `- Full business RTO: **not measured** (includes human check, grants/ownership, redeploy — see [operations.md](operations.md))`,
    `- \`accp.tasks_search_trgm\` after restore: **present** (backup uses \`pg_dump --extension=pg_trgm\` with \`--schema=accp\`; no DROP INDEX workaround)`,
    `- Evidence: \`.accp-local/m3-restore-drill/\` (local only)`,
    '',
    'This note records a reproducible interrupt+retry drill. It does not declare D04 / US-16 closed at full W0 data volume.',
    '',
  ].join('\n'), { mode: 0o644 });

  console.log(JSON.stringify({
    result: 'PASS',
    report: reportPath,
    doc: docPath,
    measured: report.measured,
    met: report.met,
  }, null, 2));
} catch (error) {
  journal('FAILED', { error: String(error) });
  writeFileSync(reportPath, JSON.stringify({
    drill_id: drillId,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    result: 'FAIL',
    error: String(error),
  }, null, 2), { mode: 0o600 });
  throw error;
} finally {
  cleanupAll();
}

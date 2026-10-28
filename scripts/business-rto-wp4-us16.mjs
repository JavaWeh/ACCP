#!/usr/bin/env node
/**
 * WP-4 / US-16 Stage D — measure FULL BUSINESS RTO from a retained Stage C .age backup.
 *
 * Fresh empty Postgres → accp-ops restore --isolated → optional ownership/grants →
 * development serve against restored DB → finish-recovery / maintenance leave when
 * applicable → healthz/readyz → alice development-token probe.
 *
 * Production Compose / empty JetStream / full doctor are attempted only when feasible;
 * otherwise recorded as residuals (no invented passes).
 *
 * Does NOT commit, edit docs/releases, or change product Go/UI.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, unlinkSync, readdirSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

function printHelp() {
  process.stdout.write(`Usage: node scripts/business-rto-wp4-us16.mjs --isolated [options]

Measure business RTO gates against a retained Stage C backup.

Required:
  --isolated
  --directory <path>     Evidence dir (e.g. .accp-local/wp4-us16-restore-drill)
  --network <name>       Docker network (e.g. accp-restore-drill)
  --ops-image <ref>      accp-ops image
  --image <digest-ref>   Matching app image digest from backup manifest
  --app-image <ref>      Runnable app image for serve/maintenance/doctor (e.g. accp:local)

Optional:
  --drill-id <uuid>      Default: discover from directory .age / report.json
  --api-port <n>         Host loopback port (default 18082)
  --postgres-image <ref> Default postgres:17
  --nats-image <ref>     Default nats:2.11.9-alpine (digest-matched production image when available)
  --with-empty-jetstream Start empty JetStream/NATS + worker on the drill network (default true)
  --skip-production-compose  Skip full production compose (OIDC/Caddy); default true — run that stack separately
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
    directory: { type: 'string' },
    network: { type: 'string' },
    'ops-image': { type: 'string' },
    image: { type: 'string' },
    'app-image': { type: 'string' },
    'drill-id': { type: 'string' },
    'api-port': { type: 'string', default: '18082' },
    'postgres-image': { type: 'string', default: 'postgres:17' },
    'nats-image': { type: 'string', default: 'nats:2.11.9-alpine' },
    'with-empty-jetstream': { type: 'boolean', default: true },
    'skip-production-compose': { type: 'boolean', default: true },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  printHelp();
  process.exit(0);
}
if (!values.isolated) throw new Error('--isolated required');
for (const name of ['directory', 'network', 'ops-image', 'image', 'app-image']) {
  if (!values[name]) throw new Error(`--${name} required`);
}

const directory = resolve(values.directory);
const network = values.network;
const opsImage = values['ops-image'];
const imageDigest = values.image;
const appImage = values['app-image'];
const postgresImage = values['postgres-image'];
const apiPort = Math.max(1024, Math.min(65535, Number.parseInt(values['api-port'], 10) || 18082));
const natsImage = values['nats-image'];
const withEmptyJetstream = values['with-empty-jetstream'] !== false;
const runId = randomUUID();
const password = randomUUID().replace(/-/g, '');
const rolePassword = randomUUID().replace(/-/g, '');
const sessionKey = randomBytes(32).toString('hex');
const natsToken = 'nats_' + randomBytes(24).toString('hex');
const pgContainer = `accp-wp4-us16-biz-pg-${runId.slice(0, 8)}`;
const apiContainer = `accp-wp4-us16-biz-api-${runId.slice(0, 8)}`;
const natsContainer = `accp-wp4-us16-biz-nats-${runId.slice(0, 8)}`;
const workerContainer = `accp-wp4-us16-biz-worker-${runId.slice(0, 8)}`;
const createdContainers = [];
const journalPath = join(directory, 'business-rto.jsonl');
const summaryPath = join(directory, 'business-rto-summary.json');
const targetUrlFile = join(directory, 'business-rto-database-url');
const apiUrlFile = join(directory, 'business-rto-api-database-url');
const natsTokenFile = join(directory, 'business-rto-nats-token');
const doctorPath = join(directory, 'doctor.json');
const grantsCheckPath = join(directory, 'grants-check.json');
const consolePath = join(directory, 'stage-f-business-rto-console.log');
const consoleLines = [];

function resolveDrillId() {
  if (values['drill-id']) return values['drill-id'];
  const reportPath = join(directory, 'report.json');
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (report.drill_id) return report.drill_id;
  }
  const ages = readdirSync(directory).filter((n) => /^drill-.*\.age$/.test(n));
  if (ages.length === 1) return ages[0].replace(/^drill-/, '').replace(/\.age$/, '');
  throw new Error('cannot discover drill-id; pass --drill-id');
}

const drillId = resolveDrillId();
const backupFile = join(directory, `drill-${drillId}.age`);
const identityFile = join(directory, `backup-identity-${drillId}`);
const usersFile = join(directory, 'source-users.json');
const stageCReportPath = join(directory, 'report.json');

if (!existsSync(backupFile)) throw new Error(`missing backup ${backupFile}`);
if (!existsSync(identityFile)) throw new Error(`missing identity ${identityFile}`);
if (!existsSync(usersFile)) throw new Error(`missing ${usersFile}`);

const stageCReport = existsSync(stageCReportPath)
  ? JSON.parse(readFileSync(stageCReportPath, 'utf8'))
  : null;
const incidentAt = stageCReport?.incident_at
  || new Date(Date.now()).toISOString();

const sleepMs = (ms) => {
  spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${Math.max(0, ms | 0)})`], { windowsHide: true });
};

const docker = (args, opts = {}) => {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeout ?? 10 * 60 * 1000,
  });
  if (opts.allowFail) return result;
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 6).join(' ')} failed: ${(result.stderr || result.stdout || '').slice(0, 2000)}`);
  }
  return result;
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  consoleLines.push(line);
  process.stdout.write(line + '\n');
}

function journal(gate, status, extra = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  const entry = { at, gate, status, run_id: runId, drill_id: drillId, ...extra };
  const fd = openSync(journalPath, 'a', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(entry) + '\n');
  } finally {
    closeSync(fd);
  }
  return entry;
}

function waitReady(container, db = 'accp_restore') {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const ready = docker(['exec', container, 'pg_isready', '-U', 'accp', '-d', db], { allowFail: true });
    if (ready.status === 0) return;
    sleepMs(1000);
  }
  throw new Error(`postgres ${container} not ready`);
}

function waitAPI(originURL) {
  const deadline = Date.now() + 120000;
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

function opsRun(args, mounts, opts = {}) {
  return docker([
    'run', '--rm',
    '--network', network,
    '--user', '65532:65532',
    '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=2g',
    ...mounts.flatMap((m) => ['--mount', m]),
    opsImage,
    ...args,
  ], opts);
}

function cleanupTemps() {
  for (const name of [workerContainer, apiContainer, natsContainer, pgContainer, ...createdContainers]) {
    docker(['rm', '-f', name], { allowFail: true });
  }
}

const gates = {};
const residuals = [];
const t0Operator = new Date();
const t0Kind = 'operator_start_of_recovery_work';
let tReady = null;
let origin = '';

mkdirSync(directory, { recursive: true, mode: 0o700 });
if (existsSync(journalPath)) unlinkSync(journalPath);

journal('T0', 'recorded', {
  t0: t0Operator.toISOString(),
  t0_kind: t0Kind,
  note: 'Business RTO clock starts at operator recovery start (not incident_at). incident_at retained from Stage C for RPO context only.',
  incident_at: incidentAt,
  snapshot_at: stageCReport?.snapshot_at ?? null,
  image: imageDigest,
});
gates.t0 = { status: 'pass', at: t0Operator.toISOString(), kind: t0Kind };
log(`T0 ${t0Operator.toISOString()} (${t0Kind})`);

try {
  // --- Gate: fresh restore ---
  const restoreStarted = new Date();
  journal('RESTORE_START', 'started', { container: pgContainer });
  docker(['rm', '-f', pgContainer], { allowFail: true });
  docker([
    'run', '-d', '--name', pgContainer, '--network', network,
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', 'POSTGRES_USER=accp',
    '-e', 'POSTGRES_DB=accp_restore',
    postgresImage,
  ]);
  createdContainers.push(pgContainer);
  waitReady(pgContainer, 'accp_restore');
  const operatorURL = `postgres://accp:${password}@${pgContainer}:5432/accp_restore?sslmode=disable&options=-csearch_path%3Daccp`;
  writeFileSync(targetUrlFile, operatorURL + '\n', { mode: 0o600 });

  const restore = opsRun(
    [
      'restore', '--isolated',
      '--database-url-file', '/run/target-url',
      '--input', `/work/drill-${drillId}.age`,
      '--identity-file', `/work/backup-identity-${drillId}`,
      '--actor', 'user_alice',
      '--reason', 'WP-4 US-16 Stage D business RTO restore',
      '--incident-at', incidentAt,
    ],
    [
      `type=bind,source=${directory},target=/work`,
      `type=bind,source=${targetUrlFile},target=/run/target-url,readonly`,
    ],
    { timeout: 55 * 60 * 1000 },
  );
  const restoreReport = JSON.parse(restore.stdout);
  const restoreFinished = new Date();
  if (!restoreReport.verified) throw new Error('restore verified!=true');
  gates.restore = {
    status: 'pass',
    at: restoreFinished.toISOString(),
    started_at: restoreStarted.toISOString(),
    command_rto_seconds: restoreReport.rto_seconds,
    rpo_seconds: restoreReport.rpo_seconds,
    verified: restoreReport.verified,
    maintenance: restoreReport.maintenance,
    pending_reconciliation: restoreReport.pending_reconciliation,
  };
  journal('RESTORE_OK', 'pass', gates.restore);
  log(`RESTORE ok rpo=${restoreReport.rpo_seconds}s command_rto=${restoreReport.rto_seconds}s`);

  // --- Gate: ownership / grants ---
  const ownershipStarted = new Date();
  let ownershipStatus = 'pass';
  let ownershipDetail = {};
  try {
    const roleSQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='accp_migrator') THEN
    CREATE ROLE accp_migrator LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='accp_api') THEN
    CREATE ROLE accp_api LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='accp_worker') THEN
    CREATE ROLE accp_worker LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='accp_bootstrap') THEN
    CREATE ROLE accp_bootstrap LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT CONNECT ON DATABASE accp_restore TO accp_migrator,accp_api,accp_worker,accp_bootstrap;
ALTER ROLE accp_migrator IN DATABASE accp_restore SET search_path=accp;
ALTER ROLE accp_api IN DATABASE accp_restore SET search_path=accp;
ALTER ROLE accp_worker IN DATABASE accp_restore SET search_path=accp;
ALTER ROLE accp_bootstrap IN DATABASE accp_restore SET search_path=accp;
`;
    docker([
      'exec', '-u', 'postgres', pgContainer,
      'psql', '-U', 'accp', '-d', 'accp_restore', '-v', 'ON_ERROR_STOP=1', '-c', roleSQL,
    ]);
    const ownershipMount = resolve('deploy/production/restore-ownership.sql');
    const grantsMount = resolve('deploy/production/grants.sql');
    docker(['cp', ownershipMount, `${pgContainer}:/tmp/restore-ownership.sql`]);
    const ownRun = docker([
      'exec', '-u', 'postgres', pgContainer,
      'psql', '-U', 'accp', '-d', 'accp_restore', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/restore-ownership.sql',
    ], { allowFail: true });
    if (ownRun.status !== 0) {
      throw new Error(`restore-ownership.sql failed: ${(ownRun.stderr || ownRun.stdout || '').slice(0, 1500)}`);
    }
    docker(['cp', grantsMount, `${pgContainer}:/tmp/grants.sql`]);
    const grantsRun = docker([
      'exec', '-u', 'postgres', pgContainer,
      'psql', '-U', 'accp', '-d', 'accp_restore', '-v', 'ON_ERROR_STOP=1',
      '-c', 'SET search_path=accp,public;',
      '-f', '/tmp/grants.sql',
    ], { allowFail: true });
    if (grantsRun.status !== 0) {
      throw new Error(`grants.sql failed: ${(grantsRun.stderr || grantsRun.stdout || '').slice(0, 1500)}`);
    }
    const privMount = resolve('deploy/production/check-privileges.sql');
    docker(['cp', privMount, `${pgContainer}:/tmp/check-privileges.sql`]);
    const privRun = docker([
      'exec', '-u', 'postgres', pgContainer,
      'psql', '-U', 'accp', '-d', 'accp_restore', '-v', 'ON_ERROR_STOP=1',
      '-c', 'SET search_path=accp,public;',
      '-f', '/tmp/check-privileges.sql',
    ], { allowFail: true });
    const privOut = `${privRun.stdout || ''}\n${privRun.stderr || ''}`.slice(0, 2000);
    const privilegeProbe = docker([
      'exec', '-u', 'postgres', pgContainer,
      'psql', '-U', 'accp', '-d', 'accp_restore', '-tA', '-c',
      `SET search_path=accp,public;
       SELECT has_table_privilege('accp_api','accp.human_users','UPDATE')::text
         || ',' || has_column_privilege('accp_api','accp.human_users','active','UPDATE')::text
         || ',' || has_table_privilege('accp_api','accp.task_contexts','DELETE')::text;`,
    ], { allowFail: true });
    const check = opsRun(
      ['check', '--database-url-file', '/run/target-url'],
      [`type=bind,source=${targetUrlFile},target=/run/target-url,readonly`],
      { allowFail: true },
    );
    writeFileSync(grantsCheckPath, JSON.stringify({
      ops_check_status: check.status,
      ops_check_stdout: (check.stdout || '').trim(),
      ops_check_stderr: (check.stderr || '').trim(),
      check_privileges_status: privRun.status,
      check_privileges_output: privOut,
      privilege_probe: (privilegeProbe.stdout || '').trim(),
    }, null, 2) + '\n', { mode: 0o600 });
    if (check.status !== 0) {
      // Intended contract: grants.sql column UPDATE(id,active) + check-privileges.sql.
      // After Stage F, accp-ops CheckGrants is column-aware; failure here is a real residual.
      if (privRun.status === 0) {
        ownershipStatus = 'pass';
        ownershipDetail = {
          roles_created: true,
          ownership_sql: true,
          grants_sql: true,
          check_privileges_sql: true,
          ops_check: 'fail',
          ops_check_error: (check.stderr || check.stdout || '').trim().slice(0, 800),
          privilege_probe: (privilegeProbe.stdout || '').trim(),
          note: 'SQL grants + check-privileges.sql OK; accp-ops check still failing after column-aware fix — investigate',
        };
        residuals.push({
          gate: 'accp_ops_check',
          reason: ownershipDetail.ops_check_error,
          note: ownershipDetail.note,
        });
        journal('OWNERSHIP_GRANTS', 'pass', ownershipDetail);
        log('OWNERSHIP/GRANTS pass (SQL); accp-ops check FAIL — see grants-check.json');
      } else {
        throw new Error(`accp-ops check failed and check-privileges.sql failed: check=${(check.stderr || check.stdout || '').slice(0, 800)} priv=${privOut}`);
      }
    } else {
      ownershipDetail = {
        roles_created: true,
        ownership_sql: true,
        grants_sql: true,
        check_privileges_sql: privRun.status === 0,
        ops_check: JSON.parse(check.stdout),
        privilege_probe: (privilegeProbe.stdout || '').trim(),
      };
      journal('OWNERSHIP_GRANTS', 'pass', ownershipDetail);
      log('OWNERSHIP/GRANTS pass (roles + restore-ownership.sql + grants.sql + accp-ops check)');
    }
  } catch (error) {
    ownershipStatus = 'fail';
    ownershipDetail = { error: String(error).slice(0, 2000) };
    residuals.push({ gate: 'ownership_grants', reason: String(error).slice(0, 500) });
    journal('OWNERSHIP_GRANTS', 'fail', ownershipDetail);
    log(`OWNERSHIP/GRANTS fail: ${error}`);
  }
  gates.ownership_grants = {
    status: ownershipStatus,
    at: new Date().toISOString(),
    started_at: ownershipStarted.toISOString(),
    ...ownershipDetail,
  };

  // API URL: use least-privilege accp_api when grants succeeded; else operator URL.
  const apiDBURL = ownershipStatus === 'pass'
    ? `postgres://accp_api:${rolePassword}@${pgContainer}:5432/accp_restore?sslmode=disable&options=-csearch_path%3Daccp`
    : operatorURL;
  writeFileSync(apiUrlFile, apiDBURL + '\n', { mode: 0o600 });

  // --- Gate: empty JetStream / NATS (operations.md step 5) ---
  writeFileSync(natsTokenFile, natsToken + '\n', { mode: 0o600 });
  if (withEmptyJetstream) {
    const natsStarted = new Date();
    try {
      docker(['rm', '-f', natsContainer], { allowFail: true });
      // Fresh anonymous volume = empty JetStream store (do not reuse prior nats-data).
      const natsConf = resolve('configs/nats.conf');
      // Match deploy/production/compose.yaml nats service (empty volume = empty JetStream).
      docker([
        'run', '-d', '--name', natsContainer, '--network', network,
        '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
        '-e', `ACCP_NATS_TOKEN=${natsToken}`,
        '--mount', `type=bind,source=${natsConf},target=/etc/nats/accp.conf,readonly`,
        '--mount', 'type=volume,destination=/data',
        '--entrypoint', '/bin/sh',
        natsImage,
        '-ec', 'export ACCP_NATS_TOKEN="$(printenv ACCP_NATS_TOKEN)"; exec nats-server -c /etc/nats/accp.conf',
      ]);
      createdContainers.push(natsContainer);
      const natsDeadline = Date.now() + 60000;
      let natsHealthy = false;
      while (Date.now() < natsDeadline) {
        const hz = docker(['exec', natsContainer, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8222/healthz'], { allowFail: true });
        if (hz.status === 0) {
          natsHealthy = true;
          break;
        }
        sleepMs(1000);
      }
      if (!natsHealthy) throw new Error('NATS healthz not ready');
      const jsz = docker(['exec', natsContainer, 'wget', '-q', '-O', '-', 'http://127.0.0.1:8222/jsz'], { allowFail: true });
      gates.jetstream_nats = {
        status: 'pass',
        at: new Date().toISOString(),
        started_at: natsStarted.toISOString(),
        container: natsContainer,
        image: natsImage,
        empty_store: true,
        note: 'Fresh volume mount at /data per operations.md empty JetStream; production compose stack exercised separately for OIDC/TLS doctor',
        jsz_tail: (jsz.stdout || '').trim().slice(0, 400),
      };
      journal('JETSTREAM_NATS', 'pass', gates.jetstream_nats);
      log('NATS empty JetStream pass');
    } catch (error) {
      gates.jetstream_nats = {
        status: 'fail',
        at: new Date().toISOString(),
        started_at: natsStarted.toISOString(),
        reason: String(error).slice(0, 800),
      };
      residuals.push({ gate: 'jetstream_nats', reason: gates.jetstream_nats.reason });
      journal('JETSTREAM_NATS', 'fail', gates.jetstream_nats);
      log(`NATS fail: ${error}`);
    }
  } else {
    gates.jetstream_nats = {
      status: 'residual',
      at: new Date().toISOString(),
      reason: '--with-empty-jetstream disabled',
    };
    residuals.push({ gate: 'jetstream_nats', reason: gates.jetstream_nats.reason });
    journal('JETSTREAM_NATS', 'residual', gates.jetstream_nats);
  }

  if (values['skip-production-compose']) {
    journal('PRODUCTION_COMPOSE', 'external', {
      reason: 'Harness skips in-process OIDC/Caddy; Stage F records separate project accp-wp4-us16 production+acceptance compose + doctor',
    });
  }

  // --- Gate: redeploy / serve (+ worker when JetStream up) ---
  const serveStarted = new Date();
  origin = `http://127.0.0.1:${apiPort}`;
  docker(['rm', '-f', apiContainer], { allowFail: true });
  const natsURL = gates.jetstream_nats?.status === 'pass' ? `nats://${natsContainer}:4222` : '';
  const apiArgs = [
    'run', '-d', '--name', apiContainer, '--network', network,
    '-p', `127.0.0.1:${apiPort}:8080`,
    '-e', `DATABASE_URL=${apiDBURL}`,
    '-e', 'ACCP_ENV=development',
    '-e', 'ACCP_AUTH_MODE=development',
    '-e', 'ACCP_LISTEN_ADDR=0.0.0.0:8080',
    '-e', `ACCP_PUBLIC_URL=${origin}`,
    '-e', `ACCP_SESSION_KEY=${sessionKey}`,
    '-e', 'ACCP_DATABASE_MAX_CONNS=20',
  ];
  if (natsURL) {
    apiArgs.push('-e', `ACCP_NATS_URL=${natsURL}`, '-e', `ACCP_NATS_TOKEN=${natsToken}`);
  }
  apiArgs.push(appImage, 'serve');
  docker(apiArgs);
  createdContainers.push(apiContainer);

  let workerStarted = false;
  if (natsURL && ownershipStatus === 'pass') {
    docker(['rm', '-f', workerContainer], { allowFail: true });
    docker([
      'run', '-d', '--name', workerContainer, '--network', network,
      '-e', `DATABASE_URL=postgres://accp_worker:${rolePassword}@${pgContainer}:5432/accp_restore?sslmode=disable&options=-csearch_path%3Daccp`,
      '-e', 'ACCP_ENV=development',
      '-e', 'ACCP_AUTH_MODE=development',
      '-e', `ACCP_PUBLIC_URL=${origin}`,
      '-e', `ACCP_SESSION_KEY=${sessionKey}`,
      '-e', `ACCP_NATS_URL=${natsURL}`,
      '-e', `ACCP_NATS_TOKEN=${natsToken}`,
      '-e', 'ACCP_DATABASE_MAX_CONNS=20',
      appImage, 'worker',
    ]);
    createdContainers.push(workerContainer);
    workerStarted = true;
    sleepMs(5000);
  }

  waitAPI(origin);
  gates.redeploy_serve = {
    status: 'pass',
    at: new Date().toISOString(),
    started_at: serveStarted.toISOString(),
    origin,
    container: apiContainer,
    image: imageDigest,
    app_image: appImage,
    database_role: ownershipStatus === 'pass' ? 'accp_api' : 'accp',
    worker: workerStarted ? workerContainer : 'not_started',
    nats: natsURL || 'not_started',
    note: workerStarted
      ? 'API+worker against restored DB with empty JetStream (development auth; not OIDC/TLS doctor matrix)'
      : 'API only; worker omitted because JetStream gate did not pass or grants failed',
  };
  journal('REDEPLOY_SERVE', 'pass', gates.redeploy_serve);
  log(`SERVE ready at ${origin} worker=${gates.redeploy_serve.worker}`);

  // --- Gate: finish-recovery / maintenance leave ---
  const finishStarted = new Date();
  let finishStatus = 'pass';
  let finishDetail = {};
  try {
    // Operator URL needed for finish-recovery / maintenance (elevated DB ops).
    const finish = opsRun(
      [
        'finish-recovery',
        '--database-url-file', '/run/target-url',
        '--actor', 'user_alice',
        '--reason', 'WP-4 US-16 Stage D: no unresolved recovery items; sessions revoked by restore',
      ],
      [`type=bind,source=${targetUrlFile},target=/run/target-url,readonly`],
      { allowFail: true },
    );
    if (finish.status !== 0) {
      throw new Error(`finish-recovery failed: ${(finish.stderr || finish.stdout || '').slice(0, 1500)}`);
    }
    const leave = docker([
      'run', '--rm', '--network', network,
      '-e', `DATABASE_URL=${operatorURL}`,
      appImage,
      'maintenance', '--action', 'leave', '--actor', 'user_alice',
      '--reason', 'WP-4 US-16 Stage D business RTO leave after finish-recovery',
    ], { allowFail: true });
    if (leave.status !== 0) {
      throw new Error(`maintenance leave failed: ${(leave.stderr || leave.stdout || '').slice(0, 1500)}`);
    }
    finishDetail = {
      finish_recovery: 'ok',
      maintenance_leave: 'ok',
      finish_stdout: (finish.stdout || '').trim().slice(0, 500),
      leave_stdout: (leave.stdout || '').trim().slice(0, 500),
    };
    journal('FINISH_RECOVERY', 'pass', finishDetail);
    log('FINISH-RECOVERY + maintenance leave pass');
  } catch (error) {
    finishStatus = 'fail';
    finishDetail = { error: String(error).slice(0, 2000) };
    residuals.push({ gate: 'finish_recovery_maintenance', reason: String(error).slice(0, 500) });
    journal('FINISH_RECOVERY', 'fail', finishDetail);
    log(`FINISH-RECOVERY fail: ${error}`);
  }
  gates.finish_recovery_maintenance = {
    status: finishStatus,
    at: new Date().toISOString(),
    started_at: finishStarted.toISOString(),
    ...finishDetail,
  };

  // --- Gate: doctor (restore path = development auth; full OIDC doctor is separate prod compose evidence) ---
  const doctorStarted = new Date();
  const doctorArgs = [
    'run', '--rm', '--network', network,
    '-e', `DATABASE_URL=${apiDBURL}`,
    '-e', 'ACCP_ENV=development',
    '-e', 'ACCP_AUTH_MODE=development',
    '-e', `ACCP_PUBLIC_URL=${origin}`,
    '-e', `ACCP_SESSION_KEY=${sessionKey}`,
  ];
  if (gates.jetstream_nats?.status === 'pass') {
    doctorArgs.push('-e', `ACCP_NATS_URL=nats://${natsContainer}:4222`, '-e', `ACCP_NATS_TOKEN=${natsToken}`);
  }
  doctorArgs.push(appImage, 'doctor', '-json');
  const doctorRun = docker(doctorArgs, { allowFail: true });
  writeFileSync(doctorPath, (doctorRun.stdout || doctorRun.stderr || '') + '\n', { mode: 0o600 });
  let doctorParsed = null;
  try { doctorParsed = JSON.parse((doctorRun.stdout || '').trim().split(/\n/).pop()); } catch { /* keep raw */ }
  const doctorOk = doctorRun.status === 0 && doctorParsed?.ok === true;
  gates.doctor = {
    status: doctorOk ? 'pass' : 'residual',
    at: new Date().toISOString(),
    started_at: doctorStarted.toISOString(),
    exit_status: doctorRun.status,
    report: doctorParsed,
    reason: doctorOk
      ? undefined
      : 'Restore-path doctor uses development auth (W0 seed); production_oidc/public_tls expected false. Full doctor evidence is stage-f/doctor-prod-compose.json from production+acceptance compose.',
  };
  if (!doctorOk) {
    residuals.push({ gate: 'doctor_restore_path', reason: gates.doctor.reason, checks: doctorParsed?.checks });
  }
  journal('DOCTOR', gates.doctor.status, gates.doctor);
  log(`DOCTOR ${gates.doctor.status}`);

  // --- Gate: healthz / readyz ---
  const hz = spawnSync(process.execPath, ['-e', `
    const o=${JSON.stringify(origin)};
    Promise.all([fetch(o+'/healthz'), fetch(o+'/readyz')]).then(async ([h,r]) => {
      const hb = await h.text(); const rb = await r.text();
      console.log(JSON.stringify({healthz:h.status,readyz:r.status,health_body:hb.slice(0,200),ready_body:rb.slice(0,200)}));
      process.exit(h.ok && r.ok ? 0 : 1);
    }).catch((e)=>{ console.error(String(e)); process.exit(1); });
  `], { windowsHide: true, encoding: 'utf8' });
  let hzBody = {};
  try { hzBody = JSON.parse((hz.stdout || '').trim()); } catch { hzBody = { raw: hz.stdout, err: hz.stderr }; }
  gates.http_ready = {
    status: hz.status === 0 ? 'pass' : 'fail',
    at: new Date().toISOString(),
    ...hzBody,
  };
  journal('HTTP_READY', gates.http_ready.status, gates.http_ready);
  log(`HTTP healthz/readyz ${gates.http_ready.status}`);
  if (gates.http_ready.status !== 'pass') {
    residuals.push({ gate: 'http_ready', reason: JSON.stringify(hzBody).slice(0, 500) });
  }

  // --- Gate: new session + authenticated read ---
  const sessionStarted = new Date();
  const credentials = JSON.parse(readFileSync(usersFile, 'utf8'));
  const alice = credentials.find((e) => e.user_id === 'user_alice')?.token;
  if (!alice) throw new Error('alice development token missing from source-users.json');

  // Confirm old agent sessions remain revoked after restore.
  const revokedCheck = docker([
    'exec', '-u', 'postgres', pgContainer,
    'psql', '-U', 'accp', '-d', 'accp_restore', '-tA', '-c',
    "SELECT format('%s|%s', count(*) FILTER (WHERE status='ACTIVE'), count(*) FILTER (WHERE status='REVOKED')) FROM accp.agent_sessions;",
  ], { allowFail: true });
  const countsLine = (revokedCheck.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const [activeCount, revokedCount] = countsLine.split('|').map((s) => Number.parseInt(String(s).trim(), 10));

  const probe = spawnSync(process.execPath, ['-e', `
    const origin=${JSON.stringify(origin)};
    const token=${JSON.stringify(alice)};
    async function main() {
      const headers = { Authorization: 'Bearer '+token, 'Content-Type': 'application/json' };
      const me = await fetch(origin+'/api/v1/me', { headers });
      const meBody = await me.json().catch(()=>({}));
      const tasks = await fetch(origin+'/api/v1/projects/project_demo/tasks', { headers });
      const tasksBody = await tasks.json().catch(()=>({}));
      let session = null;
      const manifest = {
        adapter_id: 'accp_restore_seed',
        adapter_version: '0.1.0',
        protocol_versions: ['0.2'],
        client: { name: 'stage-d-probe', version: '0.1.0' },
        capabilities: {
          claim: true, context_read: true, artifact_report: true, heartbeat: true,
          cancel: 'cooperative', notifications: ['poll'], auto_start: false,
        },
      };
      const agentRes = await fetch(origin+'/api/v1/agents', {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ project_id: 'project_demo', manifest }),
      });
      const agentBody = await agentRes.json().catch(()=>({}));
      if (agentRes.ok) {
        const grant = await fetch(origin+'/api/v1/agent-sessions', {
          method: 'POST', headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            project_id: 'project_demo',
            agent_id: agentBody.id,
            scopes: ['tasks:read','events:read','context:read'],
            expires_at: new Date(Date.now()+3600000).toISOString(),
          }),
        });
        session = { status: grant.status, body: await grant.json().catch(()=>({})) };
      } else {
        session = { status: agentRes.status, body: agentBody, note: 'agent create failed; human /me + tasks still primary probe' };
      }
      console.log(JSON.stringify({
        me_status: me.status,
        me: meBody,
        tasks_status: tasks.status,
        task_count: Array.isArray(tasksBody.items) ? tasksBody.items.length : (Array.isArray(tasksBody) ? tasksBody.length : null),
        tasks_preview: tasksBody,
        new_session: session,
      }));
      process.exit(me.ok && tasks.ok ? 0 : 1);
    }
    main().catch((e)=>{ console.error(String(e)); process.exit(1); });
  `], { windowsHide: true, encoding: 'utf8' });
  let probeBody = {};
  try { probeBody = JSON.parse((probe.stdout || '').trim().split(/\n/).filter(Boolean).pop()); } catch {
    probeBody = { raw: (probe.stdout || '').slice(0, 2000), err: (probe.stderr || '').slice(0, 1000) };
  }
  const newSessionOk = probeBody?.new_session?.status === 201
    || probeBody?.new_session?.body?.session?.status === 'ACTIVE';
  const sessionPass = probe.status === 0
    && Number.isFinite(activeCount) && activeCount === 0
    && (newSessionOk || probeBody?.me_status === 200);
  gates.session_and_probe = {
    status: sessionPass ? 'pass' : 'fail',
    at: new Date().toISOString(),
    started_at: sessionStarted.toISOString(),
    old_agent_sessions_active: activeCount,
    old_agent_sessions_revoked: revokedCount,
    authenticity_note: 'Development auth: alice bearer from retained source-users.json (digest in restored development_tokens). Not OIDC. Only alice/bob loginable.',
    probe: probeBody,
  };
  if (!sessionPass) {
    residuals.push({
      gate: 'session_and_probe',
      reason: `probe_exit=${probe.status} active_sessions=${activeCount}`,
      detail: probeBody,
    });
  }
  journal('SESSION_PROBE', gates.session_and_probe.status, gates.session_and_probe);
  log(`SESSION/PROBE ${gates.session_and_probe.status} active_old=${activeCount} revoked=${revokedCount}`);

  // --- T_ready ---
  // Honest: full business RTO only if ALL production-style gates pass.
  // Feasible subset: restore, ownership (if attempted), serve, finish-recovery, http, session.
  // JetStream + full doctor remain residuals → do not claim met.full_business_rto.
  const requiredForSubset = [
    gates.restore,
    gates.redeploy_serve,
    gates.http_ready,
    gates.session_and_probe,
  ];
  const subsetOk = requiredForSubset.every((g) => g?.status === 'pass');
  const finishOk = gates.finish_recovery_maintenance?.status === 'pass';
  const ownershipOk = gates.ownership_grants?.status === 'pass';
  // Full production business RTO also requires OIDC/TLS doctor on production compose (recorded externally).
  const jetstreamOk = gates.jetstream_nats?.status === 'pass';
  const fullProductionOk = subsetOk && finishOk && ownershipOk && jetstreamOk
    && gates.doctor?.status === 'pass';

  if (subsetOk && finishOk && ownershipOk && jetstreamOk) {
    tReady = new Date();
    journal('T_READY', 'recorded', {
      t_ready: tReady.toISOString(),
      note: 'Feasible restore gates including empty JetStream passed. Full US-16 close still requires production-compose OIDC doctor (external evidence) and no residuals.',
    });
  } else if (subsetOk && finishOk && ownershipOk) {
    tReady = new Date();
    journal('T_READY', 'recorded', {
      t_ready: tReady.toISOString(),
      note: 'Restore subset without JetStream; see residuals',
    });
  } else if (subsetOk) {
    tReady = new Date();
    journal('T_READY_SUBSET', 'recorded', {
      t_ready: tReady.toISOString(),
      note: 'Feasible subset ready; see failed/residual gates',
    });
  }

  const businessSeconds = tReady ? (tReady.getTime() - t0Operator.getTime()) / 1000 : null;
  const summary = {
    story: 'US-16 / WP-4',
    stage: 'D',
    run_id: runId,
    drill_id: drillId,
    measured_at: new Date().toISOString(),
    t0: {
      at: t0Operator.toISOString(),
      kind: t0Kind,
      incident_at_context: incidentAt,
      snapshot_at_context: stageCReport?.snapshot_at ?? null,
    },
    t_ready: tReady ? tReady.toISOString() : null,
    business_rto_seconds: businessSeconds,
    business_rto_target_seconds: 3600,
    business_rto_met_vs_3600: businessSeconds != null && businessSeconds <= 3600 && subsetOk && finishOk && ownershipOk
      ? true
      : false,
    full_business_rto_complete: fullProductionOk,
    full_business_rto_claim: fullProductionOk
      ? 'complete'
      : 'not fully measured — residuals remain (see residuals[]); feasible subset timed when t_ready set',
    command_path_from_stage_c: stageCReport?.measured ?? null,
    gates,
    residuals,
    evidence: {
      journal: 'business-rto.jsonl',
      summary: 'business-rto-summary.json',
      doctor: 'doctor.json',
      grants_check: 'grants-check.json',
      console: 'stage-d-console.log',
      backup: `drill-${drillId}.age`,
      identity: `backup-identity-${drillId}`,
    },
    honesty: {
      development_login_users: ['user_alice', 'user_bob'],
      production_compose: 'external stage-f accp-wp4-us16 (see stage-f/)',
      jetstream: jetstreamOk ? 'pass_empty_volume' : 'residual',
      doctor_restore_path: doctorOk ? 'pass' : 'residual_expected_dev_auth',
      doctor_prod_compose: 'see stage-f/doctor-prod-compose.json',
      us16_closed: false,
    },
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(consolePath, consoleLines.join('\n') + '\n', { mode: 0o600 });
  journal('SUMMARY', 'written', {
    business_rto_seconds: businessSeconds,
    full_business_rto_complete: fullProductionOk,
    residual_count: residuals.length,
  });
  log(`SUMMARY business_rto_seconds=${businessSeconds} full_complete=${fullProductionOk}`);
  process.stdout.write(JSON.stringify({ summary: summaryPath, business_rto_seconds: businessSeconds, residuals }, null, 2) + '\n');
} catch (error) {
  journal('FAILED', 'fail', { error: String(error).slice(0, 2000) });
  writeFileSync(consolePath, consoleLines.concat([String(error)]).join('\n') + '\n', { mode: 0o600 });
  cleanupTemps();
  throw error;
}

cleanupTemps();
log('cleanup: removed temporary Stage D containers; retained .age + identity + business-rto evidence');
journal('CLEANUP', 'done', {
  removed: [pgContainer, apiContainer],
  retained: [`.age`, 'identity', 'business-rto.jsonl', 'business-rto-summary.json'],
});

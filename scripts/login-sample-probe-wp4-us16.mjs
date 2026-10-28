#!/usr/bin/env node
/**
 * TEST-ONLY: login sample probe for WP-4 / US-16 Stage G.
 *
 * For each credential: GET /me, list project tasks, create agent + session.
 * Writes counts-only report (never echoes tokens). Credentials file must live
 * under .accp-local/.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';

function printHelp() {
  process.stdout.write(`Usage: node scripts/login-sample-probe-wp4-us16.mjs --isolated [options]

Required:
  --isolated
  --origin <url>           API origin (e.g. http://127.0.0.1:18082)
  --users <path>           Credentials JSON under .accp-local/
  --report <path>          Counts-only report under .accp-local/

Optional:
  --project <id>           Default project_demo
  --concurrency <n>        Default 6
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
    origin: { type: 'string' },
    users: { type: 'string' },
    report: { type: 'string' },
    project: { type: 'string', default: 'project_demo' },
    concurrency: { type: 'string', default: '6' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  printHelp();
  process.exit(0);
}
if (!values.isolated) throw new Error('--isolated required');
if (!values.origin) throw new Error('--origin required');
if (!values.users) throw new Error('--users required');
if (!values.report) throw new Error('--report required');

const usersPath = resolve(values.users);
const reportPath = resolve(values.report);
const normUsers = usersPath.replace(/\\/g, '/');
if (!normUsers.includes('.accp-local/')) {
  throw new Error('--users must be under .accp-local/');
}
if (!existsSync(usersPath)) throw new Error(`missing users file ${usersPath}`);

const credentials = JSON.parse(readFileSync(usersPath, 'utf8'));
if (!Array.isArray(credentials) || credentials.length === 0) {
  throw new Error('users file must be a non-empty JSON array');
}
for (const entry of credentials) {
  if (!entry?.user_id || !entry?.token) throw new Error('each credential needs user_id and token');
}

const origin = values.origin.replace(/\/$/, '');
const project = values.project || 'project_demo';
const concurrency = Math.max(1, Math.min(16, Number.parseInt(values.concurrency, 10) || 6));

mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });

// Temp payload keeps tokens off argv; wiped after child exits.
const payloadPath = reportPath.replace(/\.json$/i, '') + '-payload-tmp.json';
writeFileSync(payloadPath, JSON.stringify({
  origin,
  project,
  concurrency,
  credentials,
}), { mode: 0o600 });

const child = spawnSync(process.execPath, ['-e', `
const { readFileSync, writeFileSync, unlinkSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const payloadPath = process.argv[1];
const reportPath = process.argv[2];
const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
const { origin, project, concurrency, credentials } = payload;

const manifest = {
  adapter_id: 'accp_restore_seed',
  adapter_version: '0.1.0',
  protocol_versions: ['0.2'],
  client: { name: 'stage-g-login-probe', version: '0.1.0' },
  capabilities: {
    claim: true, context_read: true, artifact_report: true, heartbeat: true,
    cancel: 'cooperative', notifications: ['poll'], auto_start: false,
  },
};

async function probeOne(entry) {
  const headers = { Authorization: 'Bearer ' + entry.token, 'Content-Type': 'application/json' };
  const result = {
    user_id: entry.user_id,
    me_ok: false,
    tasks_ok: false,
    session_ok: false,
    me_status: null,
    tasks_status: null,
    session_status: null,
    error: null,
  };
  try {
    const me = await fetch(origin + '/api/v1/me', { headers });
    result.me_status = me.status;
    const meBody = await me.json().catch(() => ({}));
    result.me_ok = me.ok && meBody.id === entry.user_id;

    const tasks = await fetch(origin + '/api/v1/projects/' + project + '/tasks', { headers });
    result.tasks_status = tasks.status;
    result.tasks_ok = tasks.ok;

    const agentRes = await fetch(origin + '/api/v1/agents', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ project_id: project, manifest }),
    });
    const agentBody = await agentRes.json().catch(() => ({}));
    if (!agentRes.ok) {
      result.session_status = agentRes.status;
      result.error = 'agent_create_' + agentRes.status;
      return result;
    }
    const grant = await fetch(origin + '/api/v1/agent-sessions', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        project_id: project,
        agent_id: agentBody.id,
        scopes: ['tasks:read', 'events:read', 'context:read'],
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    });
    const grantBody = await grant.json().catch(() => ({}));
    result.session_status = grant.status;
    result.session_ok = grant.status === 201
      || grantBody?.session?.status === 'ACTIVE';
  } catch (e) {
    result.error = String(e).slice(0, 300);
  }
  return result;
}

async function main() {
  const results = [];
  for (let i = 0; i < credentials.length; i += concurrency) {
    const batch = credentials.slice(i, i + concurrency);
    const part = await Promise.all(batch.map(probeOne));
    results.push(...part);
  }
  const me_pass = results.filter((r) => r.me_ok).length;
  const tasks_pass = results.filter((r) => r.tasks_ok).length;
  const session_pass = results.filter((r) => r.session_ok).length;
  const full_pass = results.filter((r) => r.me_ok && r.tasks_ok && r.session_ok).length;
  const failures = results
    .filter((r) => !(r.me_ok && r.tasks_ok && r.session_ok))
    .map((r) => ({
      user_id: r.user_id,
      me_status: r.me_status,
      tasks_status: r.tasks_status,
      session_status: r.session_status,
      error: r.error,
    }));
  const report = {
    test_only: true,
    purpose: 'WP-4 US-16 Stage G login sample after restore',
    at: new Date().toISOString(),
    origin,
    project,
    probed: results.length,
    me_pass,
    tasks_pass,
    session_pass,
    full_pass,
    pass_all_three: full_pass === results.length,
    failures: failures.slice(0, 20),
    failure_count: failures.length,
    per_user: results.map((r) => ({
      user_id: r.user_id,
      me_ok: r.me_ok,
      tasks_ok: r.tasks_ok,
      session_ok: r.session_ok,
      me_status: r.me_status,
      tasks_status: r.tasks_status,
      session_status: r.session_status,
    })),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\\n', { mode: 0o600 });
  try { unlinkSync(payloadPath); } catch {}
  console.log(JSON.stringify({
    ok: report.pass_all_three,
    probed: report.probed,
    me_pass: report.me_pass,
    tasks_pass: report.tasks_pass,
    session_pass: report.session_pass,
    full_pass: report.full_pass,
  }));
  process.exit(report.pass_all_three ? 0 : 1);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
`, payloadPath, reportPath], {
  windowsHide: true,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  timeout: 10 * 60 * 1000,
});

try {
  if (existsSync(payloadPath)) unlinkSync(payloadPath);
} catch { /* ignore */ }

if (child.status !== 0 && child.status !== 1) {
  process.stderr.write((child.stderr || child.stdout || 'probe child failed').slice(0, 2000) + '\n');
  process.exit(child.status ?? 1);
}

const summaryLine = (child.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
process.stdout.write(summaryLine + '\n');
if (child.stderr && child.status !== 0) {
  process.stderr.write((child.stderr || '').slice(0, 1000) + '\n');
}
process.exit(child.status ?? 1);

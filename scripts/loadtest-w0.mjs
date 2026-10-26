import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: 'http://127.0.0.1:18080' },
    credentials: { type: 'string', default: '.accp-local/dev-users.json' },
    'duration-sec': { type: 'string', default: '120' },
    concurrency: { type: 'string', default: '8' },
    'seed-agent-sessions': { type: 'string', default: '0' },
    'event-samples': { type: 'string', default: '5' },
    'metrics-url': { type: 'string', default: '' },
    'output-dir': { type: 'string', default: '.accp-local/m3-loadtest' },
    project: { type: 'string', default: 'project_demo' },
  },
});

function requireLoopbackHTTP(raw, label) {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be a loopback HTTP origin without credentials or query.`);
  }
  return parsed;
}

const originURL = requireLoopbackHTTP(values.origin, 'origin');
if (originURL.pathname !== '/' && originURL.pathname !== '') {
  throw new Error('origin pathname must be empty or /');
}
const origin = `${originURL.protocol}//${originURL.host}`;
const durationSec = Math.max(15, Math.min(1800, Number.parseInt(values['duration-sec'], 10) || 120));
const concurrency = Math.max(1, Math.min(100, Number.parseInt(values.concurrency, 10) || 8));
const seedAgentSessionsTarget = Math.max(0, Math.min(500, Number.parseInt(values['seed-agent-sessions'], 10) || 0));
const eventSamples = Math.max(0, Math.min(30, Number.parseInt(values['event-samples'], 10) || 5));
const outputDir = resolve(values['output-dir']);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });

const W0_SCALE = { human_concurrency: 50, agent_sessions: 200 };

const credentials = JSON.parse(readFileSync(resolve(values.credentials), 'utf8'));
const human = credentials.find((entry) => entry.user_id === 'user_bob')?.token;
if (!human) throw new Error('A bootstrapped Bob development credential is required.');
const project = values.project;
const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const manifest = {
  adapter_id: 'accp_loadtest', adapter_version: '0.2.0', protocol_versions: ['0.2'],
  client: { name: 'w0-loadtest-driver', version: '0.1.0' },
  capabilities: { claim: true, context_read: true, artifact_report: true, heartbeat: true, cancel: 'cooperative', notifications: ['poll'], auto_start: false },
};
const sessionScopes = ['tasks:read', 'runs:claim', 'runs:write', 'context:read', 'artifacts:write', 'events:read'];

const W0 = {
  read_p95_ms: 300,
  write_p95_ms: 800,
  event_visibility_p95_ms: 2000,
  http_5xx_rate: 0.001,
};

const samples = { read: [], write: [], event: [] };
let status5xx = 0;
let statusOther = 0;
let totalRequests = 0;
const poolSnapshots = [];

async function timed(kind, fn) {
  const started = performance.now();
  try {
    const result = await fn();
    if (kind) samples[kind].push(performance.now() - started);
    return result;
  } catch (error) {
    if (kind) samples[kind].push(performance.now() - started);
    throw error;
  }
}

async function api(token, method, path, body, { version, fence, status = 200, kind, sample = true } = {}) {
  const sampleKind = sample === false ? null : (kind || (method === 'GET' ? 'read' : 'write'));
  return timed(sampleKind, async () => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (method === 'POST') headers['Idempotency-Key'] = randomUUID();
    if (version) headers['If-Match'] = `"${version}"`;
    if (fence) headers['X-Run-Fencing-Token'] = String(fence);
    const res = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    totalRequests += 1;
    if (res.status >= 500) status5xx += 1;
    else if (res.status !== status) statusOther += 1;
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status !== status) {
      throw new Error(`${method} ${path}: ${res.status} ${data?.code || 'unexpected'}, trace ${data?.trace_id || 'unknown'}`);
    }
    return data;
  });
}

async function sampleMetrics() {
  const raw = values['metrics-url'];
  if (!raw) return null;
  requireLoopbackHTTP(raw, 'metrics-url');
  try {
    const res = await fetch(raw.endsWith('/metrics') ? raw : `${raw.replace(/\/$/, '')}/metrics`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    const pick = (name) => {
      const m = text.match(new RegExp(`^${name}\\s+(\\d+(?:\\.\\d+)?)`, 'm'));
      return m ? Number(m[1]) : null;
    };
    const snap = {
      at: new Date().toISOString(),
      acquired: pick('accp_database_pool_acquired'),
      max: pick('accp_database_pool_max'),
      wait_exposed: /accp_database_pool_wait/.test(text),
    };
    poolSnapshots.push(snap);
    return snap;
  } catch (error) {
    return { error: String(error) };
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function createAgentSession({ sample = false } = {}) {
  const agent = await api(human, 'POST', '/agents', { project_id: project, manifest }, { status: 201, kind: 'write', sample });
  const grant = await api(human, 'POST', '/agent-sessions', {
    project_id: project,
    agent_id: agent.id,
    scopes: sessionScopes,
    expires_at: new Date(Date.now() + 2 * 3600000).toISOString(),
  }, { status: 201, kind: 'write', sample });
  return {
    agent_id: agent.id,
    session_id: grant.session.id,
    token: grant.access_token,
    version: grant.session.version,
  };
}

async function seedSustainedSessions(n) {
  const seeded = [];
  const errors = [];
  const batchSize = 8;
  for (let i = 0; i < n; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, n - i) }, async () => {
      try {
        return await createAgentSession({ sample: false });
      } catch (error) {
        errors.push(String(error));
        return null;
      }
    });
    const results = await Promise.all(batch);
    for (const entry of results) {
      if (entry) seeded.push(entry);
    }
  }
  return { seeded, errors };
}

async function revokeSeededSessions(seeded) {
  const errors = [];
  for (const entry of seeded) {
    try {
      const current = await api(human, 'GET', `/agent-sessions/${entry.session_id}`, undefined, { kind: 'read', sample: false });
      await api(human, 'POST', `/agent-sessions/${entry.session_id}/revoke`, { reason: 'loadtest seed cleanup' }, {
        version: current.version, kind: 'write', sample: false,
      });
    } catch (error) {
      errors.push(`${entry.session_id}: ${error}`);
    }
  }
  return errors;
}

async function keepAliveSeeded(seeded, stopAt) {
  if (!seeded.length) return;
  let cursor = 0;
  while (performance.now() < stopAt) {
    const entry = seeded[cursor % seeded.length];
    cursor += 1;
    try {
      await api(entry.token, 'GET', `/events?project_id=${project}&limit=20`, undefined, { kind: 'read' });
    } catch {
      /* keep-alive is best-effort; failures still count via api() counters */
    }
    await new Promise((r) => setTimeout(r, Math.max(50, Math.floor(1000 / Math.min(seeded.length, 20)))));
  }
}

async function eventVisibilityOnce() {
  const started = performance.now();
  const content = await api(human, 'POST', `/projects/${project}/contents`, {
    content: `W0 loadtest event sample ${randomUUID()}`, media_type: 'text/plain',
  }, { status: 201, kind: 'write' });
  const context = await api(human, 'POST', `/projects/${project}/contexts`, {
    name: `W0 loadtest ${randomUUID().slice(0, 8)}`,
    type: 'REQUIREMENT',
    source: { kind: 'ACCP', canonical_uri: `urn:accp:loadtest:${randomUUID()}` },
  }, { status: 201, kind: 'write' });
  const version = await api(human, 'POST', `/contexts/${context.id}/versions`, {
    source_revision: '1',
    content_uri: content.content_uri,
    content_digest: content.content_digest,
    media_type: content.media_type,
    change_summary: 'W0 loadtest event sample',
  }, { version: context.version, status: 201, kind: 'write' });
  await api(human, 'POST', `/contexts/${context.id}/versions/${version.id}/publish`, {}, { version: version.version, kind: 'write' });
  const task = await api(human, 'POST', `/projects/${project}/tasks`, {
    title: `W0 loadtest ${randomUUID().slice(0, 8)}`,
    objective: 'Measure event visibility under load',
    owner_user_id: 'user_bob',
    repository_id: 'repo_demo',
    acceptance_criteria: ['Event delivered'],
    context_version_ids: [version.id],
  }, { status: 201, kind: 'write' });
  const agent = await api(human, 'POST', '/agents', { project_id: project, manifest }, { status: 201, kind: 'write' });
  await api(human, 'POST', `/tasks/${task.id}/assignments`, { target: { agent_id: agent.id } }, { version: task.version, status: 201, kind: 'write' });
  const assigned = await api(human, 'GET', `/tasks/${task.id}`, undefined, { kind: 'read' });
  await api(human, 'POST', `/tasks/${task.id}/commands`, { command: 'SUBMIT', reason: 'W0 loadtest' }, { version: assigned.version, kind: 'write' });
  const grant = await api(human, 'POST', '/agent-sessions', {
    project_id: project, agent_id: agent.id,
    scopes: sessionScopes,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  }, { status: 201, kind: 'write' });
  const token = grant.access_token;
  await api(token, 'POST', '/adapters/handshake', { manifest }, { kind: 'write' });
  const claim = await api(token, 'POST', '/task-runs/claim', {
    project_id: project, task_id: task.id, base_revision: baseRevision,
  }, { status: 201, kind: 'write' });
  const run = claim.run;
  const heartbeat = await api(token, 'POST', `/task-runs/${run.id}/heartbeat`, {
    observed_at: new Date().toISOString(),
  }, { version: run.version, fence: run.fencing_token, kind: 'write' });
  const active = heartbeat.run;
  const evidence = await api(token, 'POST', `/task-runs/${run.id}/artifact-contents`, {
    content: 'W0 loadtest evidence', media_type: 'text/plain',
  }, { version: active.version, fence: active.fencing_token, status: 201, kind: 'write' });
  const artifact = await api(token, 'POST', `/task-runs/${run.id}/artifacts`, {
    kind: 'TEST_REPORT', uri: evidence.uri, content_digest: evidence.content_digest, media_type: evidence.media_type,
  }, { version: active.version, fence: active.fencing_token, status: 201, kind: 'write' });
  const reportStarted = performance.now();
  await api(token, 'POST', `/task-runs/${run.id}/reports`, {
    kind: 'COMPLETION_CANDIDATE', artifact_ids: [artifact.id],
    acceptance_report: 'W0 loadtest; not AI-client compatibility.',
  }, { version: active.version, fence: active.fencing_token, kind: 'write' });
  let cursor = '';
  let found = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const events = await api(token, 'GET', `/events?project_id=${project}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, { kind: 'read' });
    cursor = events.next_cursor;
    if (events.items.some((event) => event.type === 'io.accp.REVIEW_REQUIRED.v1' && event.data.task_id === task.id)) {
      found = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const visibilityMs = performance.now() - reportStarted;
  samples.event.push(visibilityMs);
  if (!found) throw new Error(`event visibility sample failed after ${visibilityMs.toFixed(1)}ms`);
  try {
    const current = await api(human, 'GET', `/agent-sessions/${grant.session.id}`, undefined, { kind: 'read' });
    await api(human, 'POST', `/agent-sessions/${grant.session.id}/revoke`, { reason: 'loadtest sample done' }, { version: current.version, kind: 'write' });
  } catch { /* best-effort cleanup */ }
  return { task_id: task.id, visibility_ms: visibilityMs, wall_ms: performance.now() - started };
}

async function workerLoop(stopAt) {
  while (performance.now() < stopAt) {
    await api(human, 'GET', '/me', undefined, { kind: 'read' });
    await api(human, 'GET', '/projects', undefined, { kind: 'read' });
    await api(human, 'GET', `/projects/${project}/tasks?limit=20`, undefined, { kind: 'read' });
    await api(human, 'POST', `/projects/${project}/contents`, {
      content: `W0 loadtest write ${randomUUID()}`, media_type: 'text/plain',
    }, { status: 201, kind: 'write' });
  }
}

const runStarted = new Date();
const wallStart = performance.now();
await sampleMetrics();

console.error(`Seeding ${seedAgentSessionsTarget} sustained agent sessions…`);
const seedStarted = performance.now();
const { seeded, errors: seedErrors } = await seedSustainedSessions(seedAgentSessionsTarget);
const seedSeconds = (performance.now() - seedStarted) / 1000;
console.error(`Seeded ${seeded.length}/${seedAgentSessionsTarget} in ${seedSeconds.toFixed(1)}s (${seedErrors.length} errors)`);

const stopAt = performance.now() + durationSec * 1000;
const workers = Array.from({ length: concurrency }, () => workerLoop(stopAt));
const keepAlive = keepAliveSeeded(seeded, stopAt);
const metricsTimer = setInterval(() => { sampleMetrics().catch(() => {}); }, 5000);

const eventResults = [];
const eventErrors = [];
for (let i = 0; i < eventSamples; i++) {
  try {
    eventResults.push(await eventVisibilityOnce());
  } catch (error) {
    eventErrors.push(String(error));
  }
}

await Promise.allSettled([...workers, keepAlive]);
clearInterval(metricsTimer);

console.error(`Revoking ${seeded.length} seeded sessions…`);
const cleanupErrors = await revokeSeededSessions(seeded);
await sampleMetrics();

const wallSec = (performance.now() - wallStart) / 1000;
const readP95 = percentile(samples.read, 95);
const writeP95 = percentile(samples.write, 95);
const eventP95 = percentile(samples.event, 95);
const rate5xx = totalRequests === 0 ? null : status5xx / totalRequests;

const rows = [
  { metric: 'API read P95', measured: readP95, target: W0.read_p95_ms, unit: 'ms', met: readP95 != null && readP95 < W0.read_p95_ms },
  { metric: 'API write P95', measured: writeP95, target: W0.write_p95_ms, unit: 'ms', met: writeP95 != null && writeP95 < W0.write_p95_ms },
  { metric: 'Event visibility P95', measured: eventP95, target: W0.event_visibility_p95_ms, unit: 'ms', met: eventP95 != null && eventP95 < W0.event_visibility_p95_ms && eventErrors.length === 0 },
  { metric: 'API 5xx rate', measured: rate5xx, target: W0.http_5xx_rate, unit: 'ratio', met: rate5xx != null && rate5xx < W0.http_5xx_rate },
];

const poolMaxObserved = poolSnapshots.map((s) => s.max).filter((v) => v != null);
const poolAcquiredPeak = poolSnapshots.map((s) => s.acquired).filter((v) => v != null);
const bottlenecks = [];
if (rows.some((r) => r.met === false)) {
  if (writeP95 != null && writeP95 >= W0.write_p95_ms) bottlenecks.push('writes: likely query/transaction path or pool saturation under concurrency');
  if (readP95 != null && readP95 >= W0.read_p95_ms) bottlenecks.push('reads: request queuing or shared pool contention');
  if (eventP95 != null && eventP95 >= W0.event_visibility_p95_ms) bottlenecks.push('events: global advisory-lock event delivery loop (worker) is the primary suspect');
  if (poolMaxObserved.length && poolAcquiredPeak.length && Math.max(...poolAcquiredPeak) >= Math.max(...poolMaxObserved)) {
    bottlenecks.push('pool: acquired connections reached MaxConns; consider ACCP_DATABASE_MAX_CONNS retune after retest');
  }
  if (!poolSnapshots.length || poolSnapshots.every((s) => s.error || s.acquired == null)) {
    bottlenecks.push('pool wait: metrics endpoint did not expose usable accp_database_pool_* samples (wait time is not exported today)');
  }
}

const scale = {
  human_concurrency: concurrency,
  seeded_agent_sessions: seeded.length,
  seed_target: seedAgentSessionsTarget,
  seed_errors: seedErrors,
  cleanup_errors: cleanupErrors,
  w0_targets: W0_SCALE,
  delta_to_w0: {
    human_concurrency: concurrency - W0_SCALE.human_concurrency,
    agent_sessions: seeded.length - W0_SCALE.agent_sessions,
  },
  honesty: 'human_concurrency uses a single Bob bootstrap credential as synthetic concurrent API load — not 50 distinct users. Agent sessions are real ACTIVE grants kept alive via events poll during the window, then revoked.',
};

const scopeParts = [
  `Scale achieved: human_concurrency=${concurrency} (W0 target ${W0_SCALE.human_concurrency}, delta ${concurrency - W0_SCALE.human_concurrency})`,
  `seeded_agent_sessions=${seeded.length} (W0 target ${W0_SCALE.agent_sessions}, delta ${seeded.length - W0_SCALE.agent_sessions})`,
  'Synthetic loopback mix; single Bob token approximates concurrent human API load (not 50 distinct identities)',
];

const report = {
  result: rows.every((r) => r.met) && eventErrors.length === 0 && seedErrors.length === 0 ? 'PASS' : 'FAIL',
  started_at: runStarted.toISOString(),
  finished_at: new Date().toISOString(),
  wall_seconds: wallSec,
  seed_seconds: seedSeconds,
  origin,
  duration_sec: durationSec,
  concurrency,
  seed_agent_sessions: seedAgentSessionsTarget,
  event_samples: eventSamples,
  scale,
  totals: {
    requests: totalRequests,
    status_5xx: status5xx,
    status_other_errors: statusOther,
    read_samples: samples.read.length,
    write_samples: samples.write.length,
    event_samples_ok: samples.event.length,
    event_errors: eventErrors,
  },
  w0_targets: W0,
  metrics: rows.map((r) => ({
    metric: r.metric,
    measured: r.measured,
    target: r.target,
    unit: r.unit,
    met: r.met ? 'met' : 'not-met',
  })),
  pool: {
    snapshots: poolSnapshots,
    note: 'accp_database_pool_acquired / accp_database_pool_max only; pool wait not exported by /metrics',
  },
  bottlenecks,
  event_results: eventResults,
  scope: scopeParts.join('; '),
};

const stamp = runStarted.toISOString().replace(/[:.]/g, '-');
const jsonPath = join(outputDir, `report-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2), { mode: 0o600 });
writeFileSync(join(outputDir, 'latest.json'), JSON.stringify(report, null, 2), { mode: 0o600 });

const mdLines = [
  `# W0 load test report`,
  '',
  `- Date: ${runStarted.toISOString().slice(0, 10)}`,
  `- Origin: \`${origin}\``,
  `- Duration: ${durationSec}s · concurrency ${concurrency} · seeded agent sessions ${seeded.length}/${seedAgentSessionsTarget} · event samples ${eventSamples}`,
  `- Scale vs W0: humans ${concurrency}/${W0_SCALE.human_concurrency} (delta ${concurrency - W0_SCALE.human_concurrency}); agents ${seeded.length}/${W0_SCALE.agent_sessions} (delta ${seeded.length - W0_SCALE.agent_sessions})`,
  `- Wall clock: ${wallSec.toFixed(1)}s (seed ${seedSeconds.toFixed(1)}s)`,
  `- Result: **${report.result}**`,
  `- JSON evidence: \`${jsonPath.replace(/\\/g, '/')}\``,
  '',
  '| metric | measured | W0 target | met/not-met |',
  '| --- | --- | --- | --- |',
];
for (const r of rows) {
  const measured = r.unit === 'ratio'
    ? (r.measured == null ? 'n/a' : `${(r.measured * 100).toFixed(3)}%`)
    : (r.measured == null ? 'n/a' : `${r.measured.toFixed(1)} ms`);
  const target = r.unit === 'ratio' ? `< ${(r.target * 100).toFixed(1)}%` : `< ${r.target} ms`;
  mdLines.push(`| ${r.metric} | ${measured} | ${target} | ${r.met ? 'met' : 'not-met'} |`);
}
mdLines.push('');
if (poolSnapshots.length) {
  const last = poolSnapshots[poolSnapshots.length - 1];
  mdLines.push(`Pool samples: acquired peak ${poolAcquiredPeak.length ? Math.max(...poolAcquiredPeak) : 'n/a'} / max ${poolMaxObserved.length ? Math.max(...poolMaxObserved) : 'n/a'} (wait not exposed). Last snapshot error: ${last.error || 'none'}.`);
} else {
  mdLines.push('Pool samples: none (pass `--metrics-url http://127.0.0.1:19091/metrics` when published).');
}
mdLines.push('');
if (bottlenecks.length) {
  mdLines.push('## Bottleneck notes');
  for (const note of bottlenecks) mdLines.push(`- ${note}`);
  mdLines.push('');
}
mdLines.push(`Scope: ${report.scope}.`);
mdLines.push('');

const datedMd = `docs/loadtest/w0-${runStarted.toISOString().slice(0, 10)}.md`;
mkdirSync(resolve('docs/loadtest'), { recursive: true });
writeFileSync(resolve(datedMd), mdLines.join('\n'), { mode: 0o644 });
writeFileSync(join(outputDir, 'summary.md'), mdLines.join('\n'), { mode: 0o600 });

console.log(JSON.stringify({
  result: report.result,
  json: jsonPath,
  markdown: datedMd,
  scale: report.scale,
  metrics: report.metrics,
  bottlenecks,
}, null, 2));
if (report.result !== 'PASS') process.exitCode = 2;

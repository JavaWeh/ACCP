import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const origin = process.argv[2] || 'http://127.0.0.1:8080';
const parsed = new URL(origin);
if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
  throw new Error('Development smoke checks require a loopback HTTP origin.');
}
const credentials = JSON.parse(readFileSync(process.argv[3] || '.accp-local/dev-users.json', 'utf8'));
const human = credentials.find((entry) => entry.user_id === 'user_bob')?.token;
if (!human) throw new Error('A bootstrapped Bob development credential is required.');
const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const project = 'project_demo';
const manifest = {
  adapter_id: 'accp_smoke', adapter_version: '0.2.0', protocol_versions: ['0.2'],
  client: { name: 'protocol-smoke-driver', version: '0.2.0' },
  capabilities: { claim: true, context_read: true, artifact_report: true, heartbeat: true, cancel: 'cooperative', notifications: ['poll'], auto_start: false },
};
async function api(token, method, path, body, { version, fence, status = 200 } = {}) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (method === 'POST') headers['Idempotency-Key'] = randomUUID();
  if (version) headers['If-Match'] = `"${version}"`;
  if (fence) headers['X-Run-Fencing-Token'] = String(fence);
  const res = await fetch(`${origin}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (res.status !== status) throw new Error(`${method} ${path}: ${res.status} ${data.code || 'unexpected response'}, trace ${data.trace_id || 'unknown'}`);
  return data;
}
const content = await api(human, 'POST', `/projects/${project}/contents`, { content: 'M2 acceptance: verify delegated execution and evidence.', media_type: 'text/plain' }, { status: 201 });
const context = await api(human, 'POST', `/projects/${project}/contexts`, { name: 'M2 smoke requirement', type: 'REQUIREMENT', source: { kind: 'ACCP', canonical_uri: `urn:accp:smoke:${randomUUID()}` } }, { status: 201 });
const version = await api(human, 'POST', `/contexts/${context.id}/versions`, { source_revision: '1', content_uri: content.content_uri, content_digest: content.content_digest, media_type: content.media_type, change_summary: 'Acceptance input' }, { version: context.version, status: 201 });
await api(human, 'POST', `/contexts/${context.id}/versions/${version.id}/publish`, {}, { version: version.version });
const task = await api(human, 'POST', `/projects/${project}/tasks`, { title: 'M2 protocol acceptance', objective: 'Exercise real API and Worker', owner_user_id: 'user_bob', repository_id: 'repo_demo', acceptance_criteria: ['Stored evidence; human review still required'], context_version_ids: [version.id] }, { status: 201 });
const agent = await api(human, 'POST', '/agents', { project_id: project, manifest }, { status: 201 });
await api(human, 'POST', `/tasks/${task.id}/assignments`, { target: { agent_id: agent.id } }, { version: task.version, status: 201 });
const assigned = await api(human, 'GET', `/tasks/${task.id}`);
await api(human, 'POST', `/tasks/${task.id}/commands`, { command: 'SUBMIT', reason: 'Human starts protocol acceptance' }, { version: assigned.version });
const grant = await api(human, 'POST', '/agent-sessions', { project_id: project, agent_id: agent.id, scopes: ['tasks:read', 'runs:claim', 'runs:write', 'context:read', 'artifacts:write', 'events:read'], expires_at: new Date(Date.now() + 3600000).toISOString() }, { status: 201 });
const token = grant.access_token;
await api(token, 'POST', '/adapters/handshake', { manifest });
const claim = await api(token, 'POST', '/task-runs/claim', { project_id: project, task_id: task.id, base_revision: baseRevision }, { status: 201 });
const run = claim.run;
const snapshot = await api(token, 'GET', `/context-snapshots/${run.context_snapshot_id}`);
if (snapshot.content_digest !== claim.snapshot.content_digest) throw new Error('Snapshot changed');
const heartbeat = await api(token, 'POST', `/task-runs/${run.id}/heartbeat`, { observed_at: new Date().toISOString() }, { version: run.version, fence: run.fencing_token });
const active = heartbeat.run;
const evidence = await api(token, 'POST', `/task-runs/${run.id}/artifact-contents`, { content: 'The protocol smoke flow reached the evidence step.', media_type: 'text/plain' }, { version: active.version, fence: active.fencing_token, status: 201 });
const artifact = await api(token, 'POST', `/task-runs/${run.id}/artifacts`, { kind: 'TEST_REPORT', uri: evidence.uri, content_digest: evidence.content_digest, media_type: evidence.media_type }, { version: active.version, fence: active.fencing_token, status: 201 });
await api(token, 'POST', `/task-runs/${run.id}/reports`, { kind: 'COMPLETION_CANDIDATE', artifact_ids: [artifact.id], acceptance_report: 'Protocol evidence only; this is not a real AI-client compatibility run.' }, { version: active.version, fence: active.fencing_token });
const reviewed = await api(human, 'GET', `/tasks/${task.id}`);
if (reviewed.status !== 'IN_REVIEW') throw new Error('Human acceptance boundary failed');
let cursor = '', eventFound = false;
for (let attempt = 0; attempt < 50; attempt++) {
  const events = await api(token, 'GET', `/events?project_id=${project}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  cursor = events.next_cursor;
  if (events.items.some((event) => event.type === 'io.accp.REVIEW_REQUIRED.v1' && event.data.task_id === task.id)) { eventFound = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!eventFound) throw new Error('Worker did not deliver REVIEW_REQUIRED; inspect worker and NATS');
const currentSession = await api(human, 'GET', `/agent-sessions/${grant.session.id}`);
await api(human, 'POST', `/agent-sessions/${grant.session.id}/revoke`, { reason: 'Smoke finished; revoke temporary delegation' }, { version: currentSession.version });
await api(token, 'GET', `/task-runs/${run.id}`, undefined, { status: 401 });
console.log(JSON.stringify({ result: 'PASS', task_id: task.id, task_status: reviewed.status, run_id: run.id, context_snapshot_id: snapshot.id, artifact_id: artifact.id, event: 'REVIEW_REQUIRED delivered', session: 'revoked; access rejected', scope: 'Protocol smoke driver; not real AI-client compatibility' }, null, 2));

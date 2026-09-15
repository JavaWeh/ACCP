import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadContracts } from '../check-contracts.mjs';

const { ajv } = loadContracts();
const domain = 'https://accp.example/schemas/v0.1/domain.schema.json';
const event = 'https://accp.example/schemas/v0.1/event.schema.json';
const read = (name) => JSON.parse(readFileSync(`contracts/examples/valid/${name}.json`, 'utf8'));

test('an unrelated event payload cannot satisfy API_READY', () => {
  const candidate = read('event-task_assigned');
  candidate.type = 'io.accp.API_READY.v1';
  assert.equal(ajv.getSchema(event)(candidate), false);
});

test('valid lifecycle outputs still require their acceptance evidence', () => {
  const artifact = read('commit-artifact');
  assert.equal(ajv.getSchema(`${domain}#/$defs/Artifact`)(artifact), true);
  delete artifact.immutable_revision;
  assert.equal(ajv.getSchema(`${domain}#/$defs/Artifact`)(artifact), false);
  const approval = read('approval');
  assert.equal(ajv.getSchema(`${domain}#/$defs/Approval`)(approval), true);
  delete approval.decided_by_user_id;
  assert.equal(ajv.getSchema(`${domain}#/$defs/Approval`)(approval), false);
});

test('artifact registration cannot accept a forged server-derived provenance', () => {
  const candidate = read('register-artifact');
  candidate.provenance = read('artifact').provenance;
  assert.equal(ajv.getSchema(`${domain}#/$defs/RegisterArtifact`)(candidate), false);
});

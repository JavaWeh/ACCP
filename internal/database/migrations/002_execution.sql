ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('DRAFT','READY','BLOCKED','RUNNING','IN_REVIEW','DONE','CANCELED'));

ALTER TABLE tasks ADD COLUMN retry_authorized boolean NOT NULL DEFAULT true;

CREATE TABLE agents (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  document jsonb NOT NULL, manifest jsonb NOT NULL,
  UNIQUE(id,project_id,organization_id),
  FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id)
);
CREATE TABLE agent_sessions (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  agent_id text NOT NULL, delegated_by_user_id text NOT NULL, scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL, status text NOT NULL CHECK(status IN ('ACTIVE','REVOKED','EXPIRED')),
  protocol_version text, accepted_capabilities jsonb, version bigint NOT NULL DEFAULT 1,
  UNIQUE(id,project_id,organization_id),
  FOREIGN KEY(agent_id,project_id,organization_id) REFERENCES agents(id,project_id,organization_id),
  FOREIGN KEY(project_id,organization_id,delegated_by_user_id) REFERENCES memberships(project_id,organization_id,user_id)
);
CREATE TABLE assignments (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  task_id text NOT NULL, agent_id text, capability_queue text, active boolean NOT NULL DEFAULT true,
  document jsonb NOT NULL,
  CHECK((agent_id IS NULL) <> (capability_queue IS NULL)),
  FOREIGN KEY(task_id,project_id,organization_id) REFERENCES tasks(id,project_id,organization_id),
  FOREIGN KEY(agent_id,project_id,organization_id) REFERENCES agents(id,project_id,organization_id)
);
CREATE UNIQUE INDEX assignment_active_task ON assignments(task_id) WHERE active;
CREATE TABLE task_dependencies (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  predecessor_task_id text NOT NULL, successor_task_id text NOT NULL,
  condition jsonb NOT NULL, resolved_artifact_id text, document jsonb NOT NULL,
  CHECK(predecessor_task_id <> successor_task_id),
  UNIQUE(predecessor_task_id,successor_task_id),
  FOREIGN KEY(predecessor_task_id,project_id,organization_id) REFERENCES tasks(id,project_id,organization_id),
  FOREIGN KEY(successor_task_id,project_id,organization_id) REFERENCES tasks(id,project_id,organization_id)
);
CREATE TABLE context_snapshots (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  document jsonb NOT NULL, UNIQUE(id,project_id,organization_id),
  FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id)
);
CREATE TABLE snapshot_entries (
  snapshot_id text NOT NULL, context_id text NOT NULL, context_version_id text NOT NULL,
  project_id text NOT NULL, organization_id text NOT NULL,
  PRIMARY KEY(snapshot_id,context_id),
  FOREIGN KEY(snapshot_id,project_id,organization_id) REFERENCES context_snapshots(id,project_id,organization_id),
  FOREIGN KEY(context_version_id,context_id,project_id,organization_id) REFERENCES context_versions(id,context_id,project_id,organization_id)
);
CREATE SEQUENCE run_fencing_tokens MAXVALUE 9007199254740991;
CREATE TABLE task_runs (
  id text PRIMARY KEY, task_id text NOT NULL, session_id text NOT NULL, snapshot_id text NOT NULL,
  project_id text NOT NULL, organization_id text NOT NULL, document jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','FAILED','CANCELED','LOST')),
  attempt integer NOT NULL CHECK(attempt>0), fencing_token bigint NOT NULL CHECK(fencing_token>0),
  lease_expires_at timestamptz NOT NULL, version bigint NOT NULL DEFAULT 1,
  UNIQUE(task_id,attempt), UNIQUE(id,project_id,organization_id),
  FOREIGN KEY(task_id,project_id,organization_id) REFERENCES tasks(id,project_id,organization_id),
  FOREIGN KEY(session_id,project_id,organization_id) REFERENCES agent_sessions(id,project_id,organization_id),
  FOREIGN KEY(snapshot_id,project_id,organization_id) REFERENCES context_snapshots(id,project_id,organization_id)
);
CREATE UNIQUE INDEX run_one_active ON task_runs(task_id) WHERE status='RUNNING';
CREATE INDEX run_expiry ON task_runs(lease_expires_at) WHERE status='RUNNING';
CREATE TABLE run_reports (
  id text PRIMARY KEY, run_id text NOT NULL, project_id text NOT NULL, organization_id text NOT NULL,
  document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(run_id,project_id,organization_id) REFERENCES task_runs(id,project_id,organization_id)
);
CREATE TABLE artifact_contents (
  id text PRIMARY KEY, run_id text NOT NULL, project_id text NOT NULL, organization_id text NOT NULL,
  content text NOT NULL CHECK(octet_length(content)<=262144), media_type text NOT NULL, digest text NOT NULL,
  UNIQUE(id,run_id,project_id,organization_id),
  FOREIGN KEY(run_id,project_id,organization_id) REFERENCES task_runs(id,project_id,organization_id)
);
CREATE TABLE artifacts (
  id text PRIMARY KEY, run_id text NOT NULL, project_id text NOT NULL, organization_id text NOT NULL,
  content_id text, document jsonb NOT NULL,
  verification_status text NOT NULL CHECK(verification_status IN ('UNVERIFIED','VERIFIED','FAILED')),
  acceptance_status text NOT NULL CHECK(acceptance_status IN ('PENDING','ACCEPTED','REJECTED')),
  UNIQUE(id,project_id,organization_id),
  FOREIGN KEY(run_id,project_id,organization_id) REFERENCES task_runs(id,project_id,organization_id),
  FOREIGN KEY(content_id,run_id,project_id,organization_id) REFERENCES artifact_contents(id,run_id,project_id,organization_id)
);
ALTER TABLE task_dependencies ADD FOREIGN KEY(resolved_artifact_id,project_id,organization_id) REFERENCES artifacts(id,project_id,organization_id);

ALTER TABLE idempotency_records ADD COLUMN actor_key text;
UPDATE idempotency_records SET actor_key='human:'||user_id;
ALTER TABLE idempotency_records ALTER COLUMN actor_key SET NOT NULL;
ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_pkey;
ALTER TABLE idempotency_records ADD PRIMARY KEY(project_id,actor_key,route,key);
ALTER TABLE audit_records ADD COLUMN actor_kind text NOT NULL DEFAULT 'HUMAN' CHECK(actor_kind IN ('HUMAN','AGENT','SERVICE'));
ALTER TABLE audit_records ADD COLUMN actor_session_id text;
ALTER TABLE audit_records ADD COLUMN task_run_id text;
ALTER TABLE audit_records ADD COLUMN owner_user_id text;
ALTER TABLE audit_records ADD COLUMN context_snapshot_id text;
ALTER TABLE audit_records ADD COLUMN reason text;

ALTER TABLE outbox_events ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE outbox_events ADD COLUMN replay_version integer NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox_events ADD COLUMN last_error_code text;
CREATE UNIQUE INDEX outbox_sequence ON outbox_events(sequence);
CREATE TABLE event_inbox (
  consumer_id text NOT NULL, event_id text NOT NULL REFERENCES outbox_events(id),
  processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(consumer_id,event_id)
);
CREATE TABLE event_feed (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE REFERENCES outbox_events(id), project_id text NOT NULL,
  organization_id text NOT NULL, event jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id)
);
CREATE INDEX event_project_cursor ON event_feed(project_id,sequence);
CREATE TABLE event_failures (
  event_id text PRIMARY KEY, error_code text NOT NULL, attempts bigint NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);

CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON context_snapshots FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_snapshot_entry BEFORE UPDATE OR DELETE ON snapshot_entries FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_run_report BEFORE UPDATE OR DELETE ON run_reports FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_artifact_content BEFORE UPDATE OR DELETE ON artifact_contents FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE FUNCTION protect_task_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'run history is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.status<>'RUNNING'
     OR (to_jsonb(NEW)-ARRAY['document','status','version','lease_expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['document','status','version','lease_expires_at'])
     OR (NEW.document-ARRAY['status','version','lease_expires_at']) IS DISTINCT FROM (OLD.document-ARRAY['status','version','lease_expires_at'])
     OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'run identity/input or terminal history changed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_run_identity BEFORE UPDATE OR DELETE ON task_runs FOR EACH ROW EXECUTE FUNCTION protect_task_run();

CREATE FUNCTION protect_outbox_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'outbox intent is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.event IS DISTINCT FROM OLD.event
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'outbox intent is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_outbox_intent BEFORE UPDATE OR DELETE ON outbox_events FOR EACH ROW EXECUTE FUNCTION protect_outbox_intent();

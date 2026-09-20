-- Runtime roles can lock this singleton but cannot change the maintenance flag.
CREATE TABLE runtime_state (
  id text PRIMARY KEY CHECK(id='default'),
  maintenance boolean NOT NULL DEFAULT false,
  recovery_pending boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '',
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO runtime_state(id) VALUES('default');
CREATE TABLE maintenance_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id text NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  phase text NOT NULL CHECK(phase IN ('STARTED','SUCCEEDED','FAILED')),
  details jsonb NOT NULL DEFAULT '{}',
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_maintenance_record BEFORE UPDATE OR DELETE ON maintenance_records FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE INDEX maintenance_operation ON maintenance_records(operation_id,id);
CREATE TABLE recovery_items (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  kind text NOT NULL CHECK(kind IN ('TOOL','RUN')),
  resource_id text NOT NULL,
  resolved_at timestamptz,
  resolved_by text REFERENCES human_users(id),
  evidence text,
  CHECK((resolved_at IS NULL AND resolved_by IS NULL AND evidence IS NULL) OR
    (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND length(evidence)>0))
);
CREATE INDEX recovery_pending ON recovery_items(project_id,id) WHERE resolved_at IS NULL;

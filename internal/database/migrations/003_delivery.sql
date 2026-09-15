CREATE TABLE artifact_reviews (
  id text PRIMARY KEY, artifact_id text NOT NULL, project_id text NOT NULL, organization_id text NOT NULL,
  document jsonb NOT NULL,
  FOREIGN KEY(artifact_id,project_id,organization_id) REFERENCES artifacts(id,project_id,organization_id)
);
CREATE TABLE task_reviews (
  id text PRIMARY KEY, task_id text NOT NULL, run_id text NOT NULL,
  project_id text NOT NULL, organization_id text NOT NULL, document jsonb NOT NULL,
  FOREIGN KEY(task_id,project_id,organization_id) REFERENCES tasks(id,project_id,organization_id),
  FOREIGN KEY(run_id,project_id,organization_id) REFERENCES task_runs(id,project_id,organization_id)
);
CREATE TABLE artifact_verifications (
  id text PRIMARY KEY, artifact_id text NOT NULL, project_id text NOT NULL, organization_id text NOT NULL,
  document jsonb NOT NULL,
  FOREIGN KEY(artifact_id,project_id,organization_id) REFERENCES artifacts(id,project_id,organization_id)
);
CREATE TABLE tool_policies (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  document jsonb NOT NULL, UNIQUE(id,project_id,organization_id),
  FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id)
);
CREATE TABLE tool_invocations (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  run_id text NOT NULL, session_id text NOT NULL, policy_id text NOT NULL, document jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('AWAITING_APPROVAL','READY','RUNNING','SUCCEEDED','FAILED','UNKNOWN','CANCELED')),
  dedupe_key text NOT NULL, started_at timestamptz, result jsonb,
  UNIQUE(session_id,dedupe_key), UNIQUE(id,project_id,organization_id),
  FOREIGN KEY(run_id,project_id,organization_id) REFERENCES task_runs(id,project_id,organization_id),
  FOREIGN KEY(session_id,project_id,organization_id) REFERENCES agent_sessions(id,project_id,organization_id),
  FOREIGN KEY(policy_id,project_id,organization_id) REFERENCES tool_policies(id,project_id,organization_id)
);
CREATE TABLE approvals (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  invocation_id text NOT NULL UNIQUE, document jsonb NOT NULL,
  FOREIGN KEY(invocation_id,project_id,organization_id) REFERENCES tool_invocations(id,project_id,organization_id)
);
CREATE INDEX invocation_pending ON tool_invocations(status) WHERE status IN ('READY','RUNNING','AWAITING_APPROVAL');
ALTER TABLE audit_records ADD COLUMN result text NOT NULL DEFAULT 'SUCCEEDED';
ALTER TABLE audit_records ADD COLUMN details jsonb NOT NULL DEFAULT '{}';

CREATE TRIGGER immutable_artifact_review BEFORE UPDATE OR DELETE ON artifact_reviews FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_task_review BEFORE UPDATE OR DELETE ON task_reviews FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_artifact_verification BEFORE UPDATE OR DELETE ON artifact_verifications FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE FUNCTION protect_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['document','verification_status','acceptance_status']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['document','verification_status','acceptance_status'])
    OR (NEW.document-ARRAY['verification_status','acceptance_status','version']) IS DISTINCT FROM (OLD.document-ARRAY['verification_status','acceptance_status','version'])
    OR (NEW.document->>'version')::bigint<>(OLD.document->>'version')::bigint+1
    OR OLD.acceptance_status<>'PENDING'
  THEN RAISE EXCEPTION 'artifact identity or accepted history changed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_artifact_identity BEFORE UPDATE OR DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION protect_artifact();
CREATE FUNCTION protect_invocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['document','status','started_at','result']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['document','status','started_at','result'])
    OR (NEW.document-ARRAY['status','version','result_digest','error_code','completed_at']) IS DISTINCT FROM (OLD.document-ARRAY['status','version','result_digest','error_code','completed_at'])
  THEN RAISE EXCEPTION 'invocation binding is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_invocation_binding BEFORE UPDATE OR DELETE ON tool_invocations FOR EACH ROW EXECUTE FUNCTION protect_invocation();
CREATE FUNCTION protect_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.document->>'status'<>'PENDING'
    OR (NEW.document-ARRAY['status','version','decided_by_user_id','decided_at','reason']) IS DISTINCT FROM (OLD.document-ARRAY['status','version','decided_by_user_id','decided_at','reason'])
  THEN RAISE EXCEPTION 'approval binding or decision is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_approval BEFORE UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION protect_approval();

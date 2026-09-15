CREATE TABLE organizations (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE human_users (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
  issuer text NOT NULL, subject text NOT NULL, display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (issuer, subject), UNIQUE (id, organization_id)
);
CREATE TABLE projects (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL, UNIQUE (id, organization_id)
);
CREATE TABLE memberships (
  project_id text NOT NULL, organization_id text NOT NULL, user_id text NOT NULL,
  roles text[] NOT NULL CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['ADMIN','MEMBER','REVIEWER','VIEWER']::text[]),
  active boolean NOT NULL DEFAULT true, version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (project_id, user_id), UNIQUE (project_id, organization_id, user_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (user_id, organization_id) REFERENCES human_users(id, organization_id)
);
CREATE TABLE repositories (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  document jsonb NOT NULL, UNIQUE (id, project_id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE TABLE context_contents (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  content text NOT NULL CHECK (octet_length(content) <= 262144), media_type text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  UNIQUE (id, project_id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE TABLE contexts (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  document jsonb NOT NULL, version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, project_id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE TABLE context_versions (
  id text PRIMARY KEY, context_id text NOT NULL, content_id text NOT NULL,
  project_id text NOT NULL, organization_id text NOT NULL, document jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('CANDIDATE','PUBLISHED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, project_id, organization_id),
  UNIQUE (id, context_id, project_id, organization_id),
  FOREIGN KEY (context_id, project_id, organization_id) REFERENCES contexts(id, project_id, organization_id),
  FOREIGN KEY (content_id, project_id, organization_id) REFERENCES context_contents(id, project_id, organization_id)
);
CREATE TABLE tasks (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  owner_user_id text NOT NULL, repository_id text NOT NULL, document jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','READY','BLOCKED','CANCELED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, project_id, organization_id),
  FOREIGN KEY (project_id, organization_id, owner_user_id) REFERENCES memberships(project_id, organization_id, user_id),
  FOREIGN KEY (repository_id, project_id, organization_id) REFERENCES repositories(id, project_id, organization_id)
);
CREATE TABLE task_contexts (
  task_id text NOT NULL, context_id text NOT NULL, version_id text NOT NULL,
  project_id text NOT NULL, organization_id text NOT NULL,
  PRIMARY KEY (task_id, context_id),
  FOREIGN KEY (task_id, project_id, organization_id) REFERENCES tasks(id, project_id, organization_id),
  FOREIGN KEY (version_id, context_id, project_id, organization_id) REFERENCES context_versions(id, context_id, project_id, organization_id)
);
CREATE TABLE idempotency_records (
  project_id text NOT NULL, organization_id text NOT NULL, user_id text NOT NULL,
  route text NOT NULL, key text NOT NULL, request_digest text NOT NULL,
  status integer NOT NULL, body jsonb NOT NULL, etag text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (project_id, user_id, route, key),
  FOREIGN KEY (project_id, organization_id, user_id) REFERENCES memberships(project_id, organization_id, user_id)
);
CREATE TABLE audit_records (
  id text PRIMARY KEY, organization_id text NOT NULL, project_id text NOT NULL,
  actor_user_id text NOT NULL, action text NOT NULL, resource_id text NOT NULL,
  resource_version bigint NOT NULL, trace_id text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id, actor_user_id) REFERENCES memberships(project_id, organization_id, user_id)
);
CREATE TABLE outbox_events (
  id text PRIMARY KEY, project_id text NOT NULL, organization_id text NOT NULL,
  event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE TABLE development_tokens (
  digest text PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL, expires_at timestamptz NOT NULL,
  FOREIGN KEY (issuer, subject) REFERENCES human_users(issuer, subject)
);
CREATE INDEX tasks_project_page ON tasks(project_id, id);
CREATE INDEX contexts_project_page ON contexts(project_id, id);
CREATE INDEX versions_context_page ON context_versions(context_id, id);
CREATE INDEX audit_project_page ON audit_records(project_id, id);
CREATE INDEX outbox_pending ON outbox_events(created_at) WHERE delivered_at IS NULL;

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record' USING ERRCODE = '23514'; END; $$;
CREATE TRIGGER immutable_content BEFORE UPDATE OR DELETE ON context_contents FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_records FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION protect_context_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable version' USING ERRCODE = '23514'; END IF;
  IF OLD.status <> 'CANDIDATE' OR NEW.status <> 'PUBLISHED' OR NEW.version <> OLD.version + 1
     OR (to_jsonb(NEW) - ARRAY['document','status','version']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['document','status','version'])
     OR (NEW.document - ARRAY['status','version','published_by_user_id','published_at']) IS DISTINCT FROM (OLD.document - ARRAY['status','version','published_by_user_id','published_at'])
     OR NEW.document->>'status' <> 'PUBLISHED'
     OR NOT (NEW.document ?& ARRAY['published_by_user_id','published_at'])
  THEN RAISE EXCEPTION 'only first publication is permitted' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON context_versions FOR EACH ROW EXECUTE FUNCTION protect_context_version();

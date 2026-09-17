ALTER TABLE projects ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED'));
ALTER TABLE projects ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE projects ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE organization_idempotency (
  organization_id text NOT NULL REFERENCES organizations(id), actor_id text NOT NULL,
  route text NOT NULL, key text NOT NULL, digest text NOT NULL,
  status integer NOT NULL, body jsonb NOT NULL, etag text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  PRIMARY KEY(organization_id,actor_id,route,key),
  FOREIGN KEY(actor_id,organization_id) REFERENCES human_users(id,organization_id)
);
CREATE TABLE organization_audit (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
  actor_id text NOT NULL, action text NOT NULL, resource_id text NOT NULL,
  result text NOT NULL, reason text NOT NULL DEFAULT '', trace_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(actor_id,organization_id) REFERENCES human_users(id,organization_id)
);
CREATE TRIGGER immutable_organization_audit BEFORE UPDATE OR DELETE ON organization_audit FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE INDEX organization_audit_page ON organization_audit(organization_id,id);
CREATE TABLE worker_health (
  id text PRIMARY KEY, event_at timestamptz, governance_at timestamptz, config_digest text NOT NULL DEFAULT ''
);

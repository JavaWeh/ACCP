CREATE TABLE context_git_sources (
 context_id text PRIMARY KEY REFERENCES contexts(id),
 project_id text NOT NULL REFERENCES projects(id),
 organization_id text NOT NULL REFERENCES organizations(id),
 repository_id text NOT NULL REFERENCES repositories(id),
 path text NOT NULL,
 ref text NOT NULL
);
CREATE TABLE context_git_versions (
 version_id text PRIMARY KEY REFERENCES context_versions(id),
 context_id text NOT NULL REFERENCES contexts(id),
 project_id text NOT NULL REFERENCES projects(id),
 organization_id text NOT NULL REFERENCES organizations(id),
 content_digest text NOT NULL,
 provenance jsonb NOT NULL,
 UNIQUE(context_id,content_digest)
);
CREATE TRIGGER context_git_versions_immutable BEFORE UPDATE OR DELETE ON context_git_versions
FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER context_git_sources_immutable BEFORE UPDATE OR DELETE ON context_git_sources
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

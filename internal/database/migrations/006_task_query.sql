CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX tasks_owner_workbench ON tasks(project_id, organization_id, owner_user_id, id);
CREATE INDEX tasks_status_page ON tasks(project_id, organization_id, (document->>'status'), id);
CREATE INDEX tasks_recent_page ON tasks(project_id, organization_id, (document->>'updated_at') DESC, id DESC);
CREATE INDEX tasks_owner_recent ON tasks(project_id, organization_id, owner_user_id, (document->>'updated_at') DESC, id DESC);
CREATE INDEX tasks_search_trgm ON tasks USING gin ((lower(coalesce(document->>'title','') || ' ' || coalesce(document->>'objective',''))) gin_trgm_ops);

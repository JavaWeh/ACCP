CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX tasks_owner_workbench ON tasks(project_id, organization_id, owner_user_id, id);
CREATE INDEX tasks_status_page ON tasks(project_id, organization_id, (document->>'status'), id);
CREATE INDEX tasks_recent_page ON tasks(project_id, organization_id, (document->>'updated_at') DESC, id DESC);
CREATE INDEX tasks_owner_recent ON tasks(project_id, organization_id, owner_user_id, (document->>'updated_at') DESC, id DESC);
DO $$
DECLARE extension_schema text;
BEGIN
  SELECT namespace.nspname INTO extension_schema
  FROM pg_extension extension
  JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'pg_trgm';
  IF extension_schema IS NULL THEN
    RAISE EXCEPTION 'pg_trgm extension is required for task search';
  END IF;
  EXECUTE format(
    'CREATE INDEX tasks_search_trgm ON tasks USING gin ((lower(coalesce(document->>''title'','''') || '' '' || coalesce(document->>''objective'',''''))) %I.gin_trgm_ops)',
    extension_schema
  );
END $$;

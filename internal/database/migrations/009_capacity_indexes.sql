-- Match the stable, expression-based ordering used by filtered list cursors.
CREATE INDEX tasks_filtered_updated ON tasks(project_id, organization_id, archived, (coalesce(document->>'updated_at',document->>'created_at',document->>'occurred_at','')), id);
CREATE INDEX tasks_filtered_title ON tasks(project_id, organization_id, archived, (coalesce(document->>'title',document->>'name','')), id);
CREATE INDEX tasks_filtered_status ON tasks(project_id, organization_id, archived, (document->>'status'), id);
CREATE INDEX tasks_filtered_owner ON tasks(project_id, organization_id, archived, (document->>'owner_user_id'), id);
CREATE INDEX outbox_pending_sequence ON outbox_events(sequence) WHERE delivered_at IS NULL;
CREATE INDEX audit_project_recorded ON audit_records(project_id, recorded_at, id);

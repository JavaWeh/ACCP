ALTER TABLE tasks ADD COLUMN archived boolean NOT NULL DEFAULT false;
CREATE INDEX tasks_project_archived_status_id ON tasks(project_id, archived, status, id);
CREATE INDEX tasks_project_owner_id ON tasks(project_id, owner_user_id, id);
CREATE INDEX tasks_project_updated_id ON tasks(project_id, (document->>'updated_at'), id);
CREATE TABLE task_changes (
 id text PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id),
 organization_id text NOT NULL REFERENCES organizations(id),
 task_id text NOT NULL REFERENCES tasks(id),
 version bigint NOT NULL,
 document jsonb NOT NULL,
 UNIQUE(task_id, version)
);
CREATE VIEW audit_documents AS
 SELECT a.id,a.project_id,a.organization_id,
 jsonb_strip_nulls(jsonb_build_object(
 'id',a.id,'project_id',a.project_id,'organization_id',a.organization_id,
 'actor',CASE a.actor_kind WHEN 'AGENT' THEN jsonb_build_object('kind','AGENT','session_id',a.actor_session_id,'agent_id',s.agent_id) WHEN 'SERVICE' THEN jsonb_build_object('kind','SERVICE','service_id','accp_worker') ELSE jsonb_build_object('kind','HUMAN','user_id',a.actor_user_id) END,
 'accountable_user_id',a.actor_user_id,'action',a.action,'resource_id',a.resource_id,
 'result',a.result,'trace_id',a.trace_id,'occurred_at',a.recorded_at,'details',a.details,'reason',coalesce(a.reason,''),
 'task_run_id',a.task_run_id,'owner_user_id',a.owner_user_id,'context_snapshot_id',a.context_snapshot_id,'task_id',r.task_id
 )) AS document
 FROM audit_records a LEFT JOIN agent_sessions s ON s.id=a.actor_session_id LEFT JOIN task_runs r ON r.id=a.task_run_id;
CREATE VIEW context_version_options AS SELECT v.id,v.project_id,v.organization_id,
 jsonb_build_object('id',v.id,'context_id',v.context_id,'context_name',c.document->>'name','title',c.document->>'name','source_revision',v.document->>'source_revision','status',v.status) AS document
 FROM context_versions v JOIN contexts c ON c.id=v.context_id WHERE v.status='PUBLISHED';

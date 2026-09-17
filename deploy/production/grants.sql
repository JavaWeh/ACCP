-- Run as the migration owner after every migration; never use an application login.
REVOKE ALL ON SCHEMA accp FROM PUBLIC;
GRANT USAGE ON SCHEMA accp TO accp_api,accp_worker,accp_bootstrap;
REVOKE ALL ON ALL TABLES IN SCHEMA accp FROM accp_api,accp_worker,accp_bootstrap;
GRANT SELECT ON ALL TABLES IN SCHEMA accp TO accp_api,accp_worker;
-- PostgreSQL row locks require UPDATE on at least one column. Only identity
-- columns are granted here; runtime roles cannot alter active/status/name.
GRANT UPDATE(id) ON organizations,human_users TO accp_api;
GRANT UPDATE(id) ON projects TO accp_worker;
GRANT UPDATE(id) ON runtime_state TO accp_api,accp_worker;
GRANT SELECT,INSERT ON organizations,human_users,projects,memberships,repositories TO accp_bootstrap;
GRANT SELECT ON schema_migrations TO accp_bootstrap;
GRANT INSERT ON human_users,projects,memberships,repositories,organization_idempotency,organization_audit,
 context_contents,contexts,context_versions,tasks,task_contexts,idempotency_records,audit_records,outbox_events,
 agents,agent_sessions,assignments,task_dependencies,task_runs,context_snapshots,snapshot_entries,
 artifact_contents,artifacts,run_reports,artifact_reviews,task_reviews,artifact_verifications,tool_policies,tool_invocations,approvals TO accp_api;
GRANT UPDATE ON projects,memberships,organization_idempotency,contexts,context_versions,tasks,idempotency_records,
 outbox_events,agent_sessions,assignments,task_dependencies,task_runs,artifacts,tool_policies,tool_invocations,approvals TO accp_api;
GRANT DELETE ON task_dependencies TO accp_api;
GRANT INSERT ON audit_records,outbox_events,event_inbox,event_feed,event_failures,worker_health TO accp_worker;
GRANT UPDATE ON tasks,task_runs,task_dependencies,tool_invocations,approvals,outbox_events,event_failures,worker_health TO accp_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA accp TO accp_api,accp_worker,accp_bootstrap;

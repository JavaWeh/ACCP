-- Run with the local operator socket after bootstrap. No credentials or user data are returned.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE accp_api;
SET LOCAL search_path=accp;
DO $$ BEGIN
 PERFORM id FROM human_users FOR SHARE;
 PERFORM id FROM organizations FOR UPDATE;
 PERFORM id FROM projects FOR UPDATE;
 IF has_column_privilege(current_user,'human_users','active','UPDATE') OR
    has_table_privilege(current_user,'audit_records','UPDATE') OR
    has_table_privilege(current_user,'organization_audit','DELETE') OR
    has_table_privilege(current_user,'schema_migrations','INSERT') OR
    has_schema_privilege(current_user,'accp','CREATE') THEN
  RAISE EXCEPTION 'API privilege boundary violated';
 END IF;
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE accp_worker;
SET LOCAL search_path=accp;
DO $$ BEGIN
 PERFORM id FROM projects FOR UPDATE SKIP LOCKED;
 IF has_column_privilege(current_user,'projects','status','UPDATE') OR
    has_table_privilege(current_user,'human_users','INSERT') OR
    has_table_privilege(current_user,'schema_migrations','UPDATE') OR
    has_table_privilege(current_user,'audit_records','DELETE') OR
    has_schema_privilege(current_user,'accp','CREATE') THEN
  RAISE EXCEPTION 'Worker privilege boundary violated';
 END IF;
END $$;
ROLLBACK;

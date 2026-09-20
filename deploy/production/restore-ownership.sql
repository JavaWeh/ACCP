-- Run locally as the restore operator after creating the fixed NOINHERIT roles.
-- The recovered installation must remain in maintenance throughout this step.
BEGIN;
SET LOCAL search_path=accp,public;
DO $$
DECLARE item record;
BEGIN
  IF NOT (SELECT maintenance FROM runtime_state WHERE id='default' FOR UPDATE) THEN
    RAISE EXCEPTION 'restore ownership requires maintenance';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('accp_migrator','accp_api','accp_worker','accp_bootstrap') AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb)<>4 THEN
    RAISE EXCEPTION 'create the four least-privilege roles before restoring ownership';
  END IF;
  EXECUTE 'ALTER SCHEMA accp OWNER TO accp_migrator';
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='accp' LOOP
    EXECUTE format('ALTER TABLE accp.%I OWNER TO accp_migrator',item.tablename);
  END LOOP;
  FOR item IN SELECT sequencename FROM pg_sequences WHERE schemaname='accp' LOOP
    EXECUTE format('ALTER SEQUENCE accp.%I OWNER TO accp_migrator',item.sequencename);
  END LOOP;
  FOR item IN SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='accp' LOOP
    EXECUTE format('ALTER FUNCTION accp.%I(%s) OWNER TO accp_migrator',item.proname,item.arguments);
  END LOOP;
END $$;
COMMIT;

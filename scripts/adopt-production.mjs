import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';

// Explicit maintenance command for a stopped, dedicated ACCP database. SQL travels on stdin.
const {values}=parseArgs({options:{container:{type:'string'},user:{type:'string'},directory:{type:'string'}}});
if(!values.container||!values.user||!values.directory)throw new Error('--container, --user and --directory are required');
const root=resolve(values.directory),literal=s=>"'"+s.replaceAll("'","''")+"'";
const tables=['organizations','human_users','projects','memberships','repositories','context_contents','contexts','context_versions','tasks','task_contexts','idempotency_records','audit_records','outbox_events','development_tokens','schema_migrations','agents','agent_sessions','assignments','task_dependencies','context_snapshots','snapshot_entries','task_runs','run_reports','artifact_contents','artifacts','event_inbox','event_feed','event_failures','artifact_reviews','task_reviews','artifact_verifications','tool_policies','tool_invocations','approvals'];
let sql=`BEGIN;
DO $$ BEGIN
 IF to_regnamespace('accp') IS NOT NULL OR to_regclass('public.schema_migrations') IS NULL THEN RAISE EXCEPTION 'requires the original public-schema ACCP database'; END IF;
 IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename NOT IN (${tables.map(literal).join(',')})) THEN RAISE EXCEPTION 'database contains unrelated tables'; END IF;
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend') THEN RAISE EXCEPTION 'stop all applications and database clients before adoption'; END IF;
END $$;
`;
for(const role of ['operator','migrator','bootstrap','api','worker']){
 const password=readFileSync(join(root,'secrets',role+'_password'),'utf8').trim();if(!/^[a-f0-9]{64}$/.test(password))throw new Error('Use freshly generated production role secrets');
 sql+=`CREATE ROLE accp_${role} LOGIN ${role==='operator'?'SUPERUSER':''} PASSWORD ${literal(password)};\n`;
}
sql+=`ALTER SCHEMA public RENAME TO accp;
CREATE SCHEMA public;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA accp OWNER TO accp_migrator;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='accp' AND c.relkind IN ('r','p') LOOP EXECUTE format('ALTER TABLE accp.%I OWNER TO accp_migrator',r.relname); END LOOP;
 FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='accp' AND c.relkind='S' LOOP EXECUTE format('ALTER SEQUENCE accp.%I OWNER TO accp_migrator',r.relname); END LOOP;
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='accp' LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO accp_migrator',r.signature); END LOOP;
END $$;
REVOKE ALL ON DATABASE accp FROM PUBLIC;
GRANT CONNECT ON DATABASE accp TO accp_migrator,accp_bootstrap,accp_api,accp_worker;
`;
for(const role of ['migrator','bootstrap','api','worker'])sql+=`ALTER ROLE accp_${role} IN DATABASE accp SET search_path=accp;\n`;
sql+='COMMIT;\n';
const result=spawnSync('docker',['exec','-i',values.container,'psql','-X','-v','ON_ERROR_STOP=1','-U',values.user,'-d','accp'],{input:sql,encoding:'utf8',windowsHide:true});
if(result.status!==0)throw new Error('Database adoption failed and was rolled back. Verify the stopped dedicated database and unused role names; secret-bearing SQL output is suppressed.');
console.log('Existing ACCP schema adopted without bootstrap or data deletion. Run migrations and grants with the new production roles before restarting.');

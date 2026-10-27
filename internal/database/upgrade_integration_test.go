//go:build integration

package database

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedPre007 seeds the demo org/project/repo/humans/memberships/development_tokens
// using only columns that exist before migration 007 (which adds human_users.is_org_admin).
// It mirrors bootstrap.DevelopmentSpec identities without calling bootstrap.Apply, because
// Apply unconditionally INSERTs is_org_admin and would fail against a pre-007 schema.
func seedPre007(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	stmts := []string{
		`INSERT INTO organizations(id,name) VALUES('org_demo','ACCP development')`,
		`INSERT INTO projects(id,organization_id,name) VALUES('project_demo','org_demo','Demo project')`,
		`INSERT INTO repositories(id,project_id,organization_id,document) VALUES('repo_demo','project_demo','org_demo','{"id":"repo_demo","project_id":"project_demo","organization_id":"org_demo","provider_id":"git","url":"https://github.com/JavaWeh/ACCP","default_branch":"main"}')`,
		`INSERT INTO human_users(id,organization_id,issuer,subject,display_name) VALUES('user_alice','org_demo','urn:accp:development','alice','Alice')`,
		`INSERT INTO human_users(id,organization_id,issuer,subject,display_name) VALUES('user_bob','org_demo','urn:accp:development','bob','Bob')`,
		`INSERT INTO memberships(project_id,organization_id,user_id,roles) VALUES('project_demo','org_demo','user_alice',ARRAY['ADMIN','MEMBER','REVIEWER'])`,
		`INSERT INTO memberships(project_id,organization_id,user_id,roles) VALUES('project_demo','org_demo','user_bob',ARRAY['MEMBER','REVIEWER'])`,
		`INSERT INTO development_tokens(digest,issuer,subject,expires_at) VALUES('digest_alice','urn:accp:development','alice',now()+interval '7 days')`,
		`INSERT INTO development_tokens(digest,issuer,subject,expires_at) VALUES('digest_bob','urn:accp:development','bob',now()+interval '7 days')`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
}

// assertOrgAdminBackfill verifies migration 007 added human_users.is_org_admin and backfilled
// the first project ADMIN (alice) to true.
func assertOrgAdminBackfill(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var aliceAdmin, bobAdmin bool
	if err := pool.QueryRow(ctx, `SELECT is_org_admin FROM human_users WHERE id='user_alice'`).Scan(&aliceAdmin); err != nil {
		t.Fatal("is_org_admin column missing after migration", err)
	}
	if err := pool.QueryRow(ctx, `SELECT is_org_admin FROM human_users WHERE id='user_bob'`).Scan(&bobAdmin); err != nil {
		t.Fatal(err)
	}
	if !aliceAdmin || bobAdmin {
		t.Fatal("migration 007 did not backfill the first project ADMIN as org admin")
	}
}

func TestM1DataAndIdempotencySurviveM2Migration(t *testing.T) {
	ctx := context.Background()
	admin, err := Open(ctx, os.Getenv("ACCP_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("upgrade_%x", rand.Text()[:16])
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+quoted); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, `DROP SCHEMA `+quoted+` CASCADE`)
	cfg, err := pgxpool.ParseConfig(os.Getenv("ACCP_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	original, err := migrations.ReadFile("migrations/001_control_plane.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(original)); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO schema_migrations VALUES($1,$2)`, "001_control_plane.sql", fmt.Sprintf("%x", sha256.Sum256(original))); err != nil {
		t.Fatal(err)
	}
	seedPre007(ctx, t, pool)
	_, err = pool.Exec(ctx, `INSERT INTO tasks(id,project_id,organization_id,owner_user_id,repository_id,document,status) VALUES('task_m1','project_demo','org_demo','user_bob','repo_demo','{"id":"task_m1","title":"Preserved M1 task","version":1,"status":"READY"}','READY')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO idempotency_records(project_id,organization_id,user_id,route,key,request_digest,status,body,etag) VALUES('project_demo','org_demo','user_bob','POST /api/v1/projects/project_demo/tasks','existing-m1-key','original-request-digest',201,'{"id":"task_m1"}','"1"')`)
	if err != nil {
		t.Fatal(err)
	}
	if err = Ready(ctx, pool); err == nil {
		t.Fatal("M1 schema falsely declared M2-ready")
	}
	for i := 0; i < 2; i++ {
		if err = Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}
	if err = Ready(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var status, title, actor, digest string
	var humans, tokens int
	if err = pool.QueryRow(ctx, `SELECT status,document->>'title' FROM tasks WHERE id='task_m1'`).Scan(&status, &title); err != nil {
		t.Fatal(err)
	}
	if status != "READY" || title != "Preserved M1 task" {
		t.Fatal("M1 task changed")
	}
	if err = pool.QueryRow(ctx, `SELECT actor_key,request_digest FROM idempotency_records WHERE key='existing-m1-key'`).Scan(&actor, &digest); err != nil {
		t.Fatal(err)
	}
	if actor != "human:user_bob" || digest != "original-request-digest" {
		t.Fatal("M1 idempotency identity lost")
	}
	if err = pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM human_users),(SELECT count(*) FROM development_tokens)`).Scan(&humans, &tokens); err != nil || humans != 2 || tokens != 2 {
		t.Fatal("human identities or credentials lost", err)
	}
	assertOrgAdminBackfill(ctx, t, pool)
}

func TestM2AuditAndCredentialsSurviveM3Migration(t *testing.T) {
	ctx := context.Background()
	admin, e := Open(ctx, os.Getenv("ACCP_TEST_DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	defer admin.Close()
	schema := fmt.Sprintf("upgrade_m3_%x", rand.Text()[:16])
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, e = admin.Exec(ctx, `CREATE SCHEMA `+quoted); e != nil {
		t.Fatal(e)
	}
	defer admin.Exec(ctx, `DROP SCHEMA `+quoted+` CASCADE`)
	cfg, e := pgxpool.ParseConfig(os.Getenv("ACCP_TEST_DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	if _, e = pool.Exec(ctx, `CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL)`); e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"001_control_plane.sql", "002_execution.sql"} {
		b, e := migrations.ReadFile("migrations/" + name)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = pool.Exec(ctx, string(b)); e != nil {
			t.Fatal(e)
		}
		if _, e = pool.Exec(ctx, `INSERT INTO schema_migrations VALUES($1,$2)`, name, fmt.Sprintf("%x", sha256.Sum256(b))); e != nil {
			t.Fatal(e)
		}
	}
	seedPre007(ctx, t, pool)
	if _, e = pool.Exec(ctx, `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,action,resource_id,resource_version,trace_id) VALUES('audit_m2','project_demo','org_demo','user_bob','original_m2_action','project_demo',1,'trace_m2')`); e != nil {
		t.Fatal(e)
	}
	var before string
	if e = pool.QueryRow(ctx, `SELECT md5(string_agg(digest,',' ORDER BY digest)) FROM development_tokens`).Scan(&before); e != nil {
		t.Fatal(e)
	}
	if e = Ready(ctx, pool); e == nil {
		t.Fatal("M2 schema reported M3 ready")
	}
	for i := 0; i < 2; i++ {
		if e = Migrate(ctx, pool); e != nil {
			t.Fatal(e)
		}
	}
	var result, action, after string
	if e = pool.QueryRow(ctx, `SELECT result,action FROM audit_records WHERE id='audit_m2'`).Scan(&result, &action); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, `SELECT md5(string_agg(digest,',' ORDER BY digest)) FROM development_tokens`).Scan(&after); e != nil {
		t.Fatal(e)
	}
	if result != "SUCCEEDED" || action != "original_m2_action" || before != after {
		t.Fatal("M2 history or credentials changed")
	}
	if e = Ready(ctx, pool); e != nil {
		t.Fatal(e)
	}
	assertOrgAdminBackfill(ctx, t, pool)
}

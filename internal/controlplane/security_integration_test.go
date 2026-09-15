//go:build integration

package controlplane

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/JavaWeh/ACCP/internal/auth"
)

func TestResponsesAndOutboxMatchPublicContracts(t *testing.T) {
	f := setup(t)
	c, v := f.candidate("alice")
	f.expect(f.call("alice", "GET", "/me", "", "", nil), 200, "Human")
	f.expect(f.call("alice", "GET", "/projects", "", "", nil), 200, "ProjectPage")
	f.expect(f.call("alice", "GET", "/projects/project_demo/members", "", "", nil), 200, "MembershipPage")
	f.expect(f.call("alice", "GET", "/projects/project_demo/repositories", "", "", nil), 200, "RepositoryPage")
	f.expect(f.call("alice", "GET", "/projects/project_demo/contexts", "", "", nil), 200, "ContextPage")
	f.expect(f.call("alice", "GET", "/projects/project_demo/tasks", "", "", nil), 200, "TaskPage")
	f.expect(f.call("alice", "GET", "/contexts/"+textValue(c, "id")+"/versions", "", "", nil), 200, "ContextVersionPage")
	f.expect(f.call("alice", "GET", "/contents/"+strings.TrimPrefix(textValue(v, "content_uri"), "urn:accp:content:"), "", "", nil), 200, "Content")
	f.expect(f.call("bob", "POST", "/contexts/"+textValue(c, "id")+"/versions/"+textValue(v, "id")+"/publish", "publish-outbox", `"1"`, nil), 200, "ContextVersion")
	f.expect(f.call("alice", "GET", "/projects/project_demo/audit-records", "", "", nil), 200, "AuditPage")
	var data []byte
	if err := f.pool.QueryRow(context.Background(), `SELECT event FROM outbox_events`).Scan(&data); err != nil {
		t.Fatal(err)
	}
	var event Object
	if err := json.Unmarshal(data, &event); err != nil {
		t.Fatal(err)
	}
	if err := f.server.schemas["Event"].Validate(event); err != nil {
		t.Fatal(err)
	}
}

func TestPermissionRevocationAlsoBlocksIdempotentReplay(t *testing.T) {
	f := setup(t)
	content := Object{"content": "Private content", "media_type": "text/plain"}
	f.expect(f.call("bob", "POST", "/projects/project_demo/contents", "bob-content-1", "", content), 201, "ContentMetadata")
	f.expect(f.call("alice", "POST", "/projects/project_demo/members/user_bob/changes", "demote-bob", `"1"`, Object{"roles": []string{"VIEWER"}, "active": true}), 200, "Membership")
	f.expect(f.call("bob", "POST", "/projects/project_demo/contents", "bob-content-1", "", content), 403, "")
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM context_contents`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("unexpected write count %d", count)
	}
}

func TestDevelopmentTokenExpiryAndHumanDeactivation(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	const token = "fixture-token-only"
	_, err := f.pool.Exec(ctx, `INSERT INTO development_tokens(digest,issuer,subject,expires_at) VALUES($1,'urn:accp:development','alice',now()+interval '1 hour')`, auth.Digest(token))
	if err != nil {
		t.Fatal(err)
	}
	f.server, err = New(f.pool, auth.Development{Pool: f.pool})
	if err != nil {
		t.Fatal(err)
	}
	f.expect(f.call(token, "GET", "/me", "", "", nil), 200, "Human")
	if _, err = f.pool.Exec(ctx, `UPDATE development_tokens SET expires_at=now()-interval '1 minute' WHERE digest=$1`, auth.Digest(token)); err != nil {
		t.Fatal(err)
	}
	f.expect(f.call(token, "GET", "/me", "", "", nil), 401, "")
	if _, err = f.pool.Exec(ctx, `UPDATE development_tokens SET expires_at=now()+interval '1 hour' WHERE digest=$1`, auth.Digest(token)); err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(ctx, `UPDATE human_users SET active=false WHERE subject='alice'`); err != nil {
		t.Fatal(err)
	}
	f.expect(f.call(token, "GET", "/me", "", "", nil), 403, "")
}

func TestCrossProjectContentAndDatabaseBoundaries(t *testing.T) {
	f := setup(t)
	c, v := f.candidate("alice")
	secret := f.expect(f.call("carol", "POST", "/projects/project_secret/contents", "secret-content", "", Object{"content": "secret", "media_type": "text/plain"}), 201, "ContentMetadata")
	f.expect(f.call("alice", "GET", "/contents/"+textValue(secret, "id"), "", "", nil), 404, "")
	body := Object{"source_revision": "2", "content_uri": secret["content_uri"], "content_digest": secret["content_digest"], "media_type": secret["media_type"], "change_summary": "Cross project"}
	f.expect(f.call("alice", "POST", "/contexts/"+textValue(c, "id")+"/versions", "cross-content", `"2"`, body), 422, "")
	tBody := taskBody(textValue(v, "id"))
	tBody["owner_user_id"] = "user_carol"
	tBody["repository_id"] = "repo_secret"
	f.expect(f.call("carol", "POST", "/projects/project_secret/tasks", "cross-context", "", tBody), 422, "")
	_, err := f.pool.Exec(context.Background(), `INSERT INTO tasks(id,project_id,organization_id,owner_user_id,repository_id,document,status) VALUES('task_bad','project_secret','org_demo','user_bob','repo_secret','{}','DRAFT')`)
	if err == nil {
		t.Fatal("database accepted cross-project owner")
	}
	_, err = f.pool.Exec(context.Background(), `INSERT INTO organizations VALUES('org_other','Other'); INSERT INTO projects VALUES('project_other','org_other','Other')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.pool.Exec(context.Background(), `INSERT INTO memberships(project_id,organization_id,user_id,roles) VALUES('project_other','org_other','user_alice',ARRAY['ADMIN'])`)
	if err == nil {
		t.Fatal("database accepted cross-organization human")
	}
	f.expect(f.call("alice", "GET", "/projects/project_other/tasks", "", "", nil), 404, "")
}

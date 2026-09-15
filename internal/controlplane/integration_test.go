//go:build integration

package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/JavaWeh/ACCP/internal/bootstrap"
	"github.com/JavaWeh/ACCP/internal/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type testAuth struct{}

func (testAuth) Authenticate(_ context.Context, token string) (auth.Identity, error) {
	if token == "invalid" {
		return auth.Identity{}, fmt.Errorf("invalid")
	}
	return auth.Identity{Issuer: "urn:accp:development", Subject: token}, nil
}

type fixture struct {
	t      *testing.T
	pool   *pgxpool.Pool
	server *Server
	config *pgxpool.Config
}

func setup(t *testing.T) *fixture {
	t.Helper()
	url := os.Getenv("ACCP_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("integration tests require ACCP_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	admin, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := newID("test")
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, pool: pool, config: cfg}
	t.Cleanup(func() {
		f.pool.Close()
		_, err := admin.Exec(context.Background(), `DROP SCHEMA `+pgx.Identifier{schema}.Sanitize()+` CASCADE`)
		if err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	if err = database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err = database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	spec := bootstrap.DevelopmentSpec()
	spec.Projects = append(spec.Projects, bootstrap.Project{ID: "project_secret", Name: "Private", Repository: bootstrap.Repository{ID: "repo_secret", ProviderID: "git", URL: "https://example.com/private", DefaultBranch: "main"}})
	spec.Humans = append(spec.Humans,
		bootstrap.Human{ID: "user_carol", Issuer: "urn:accp:development", Subject: "carol", DisplayName: "Carol", Memberships: []bootstrap.Membership{{ProjectID: "project_secret", Roles: []string{"ADMIN"}}}},
		bootstrap.Human{ID: "user_viewer", Issuer: "urn:accp:development", Subject: "viewer", DisplayName: "Viewer", Memberships: []bootstrap.Membership{{ProjectID: "project_demo", Roles: []string{"VIEWER"}}}},
	)
	if _, err = bootstrap.Apply(ctx, pool, spec, true); err != nil {
		t.Fatal(err)
	}
	f.server, err = New(pool, testAuth{})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fixture) call(user, method, path, key, etag string, body any) *httptest.ResponseRecorder {
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(data))
	if user != "" {
		req.Header.Set("Authorization", "Bearer "+user)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)
	req.Header.Set("If-Match", etag)
	recorder := httptest.NewRecorder()
	f.server.ServeHTTP(recorder, req)
	return recorder
}
func (f *fixture) expect(r *httptest.ResponseRecorder, status int, schema string) Object {
	f.t.Helper()
	if r.Code != status {
		f.t.Fatalf("status %d, want %d: %s", r.Code, status, r.Body.String())
	}
	var body Object
	if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil {
		f.t.Fatal(err)
	}
	if schema != "" {
		if err := f.server.schemas[schema].Validate(body); err != nil {
			f.t.Fatalf("response schema %s: %v", schema, err)
		}
	}
	if status >= 400 {
		if err := f.server.schemas["Problem"].Validate(body); err != nil {
			f.t.Fatal(err)
		}
	}
	return body
}
func (f *fixture) candidate(user string) (Object, Object) {
	f.t.Helper()
	content := f.expect(f.call(user, "POST", "/projects/project_demo/contents", newID("key"), "", Object{"content": "# Orders\nGET /orders", "media_type": "text/markdown"}), 201, "")
	c := f.expect(f.call(user, "POST", "/projects/project_demo/contexts", newID("key"), "", Object{"name": "Orders API", "type": "API", "source": Object{"kind": "ACCP", "canonical_uri": "urn:accp:orders-api"}}), 201, "Context")
	v := f.expect(f.call(user, "POST", "/contexts/"+textValue(c, "id")+"/versions", newID("key"), `"1"`, Object{"source_revision": "1", "content_uri": content["content_uri"], "content_digest": content["content_digest"], "media_type": "text/markdown", "change_summary": "Initial API"}), 201, "ContextVersion")
	return c, v
}
func taskBody(version string) Object {
	return Object{"title": "Implement orders", "objective": "Deliver an API", "owner_user_id": "user_bob", "repository_id": "repo_demo", "acceptance_criteria": []string{"Returns orders"}, "context_version_ids": []string{version}}
}

func TestTaskContextPersistenceAndIdempotency(t *testing.T) {
	f := setup(t)
	c, v := f.candidate("alice")
	path := "/contexts/" + textValue(c, "id") + "/versions/" + textValue(v, "id") + "/publish"
	create := taskBody(textValue(v, "id"))
	first := f.call("alice", "POST", "/projects/project_demo/tasks", "task-create-1", "", create)
	task := f.expect(first, 201, "Task")
	replay := f.call("alice", "POST", "/projects/project_demo/tasks", "task-create-1", "", create)
	repeated := f.expect(replay, 201, "Task")
	if task["id"] != repeated["id"] {
		t.Fatal("duplicate Task")
	}
	create["title"] = "Different"
	f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", "task-create-1", "", create), 409, "")
	taskPath := "/tasks/" + textValue(task, "id")
	blocked := f.expect(f.call("bob", "POST", taskPath+"/commands", "submit-blocked", `"1"`, Object{"command": "SUBMIT", "reason": "Ready to start"}), 200, "Task")
	if blocked["status"] != "BLOCKED" {
		t.Fatal("candidate Context should block")
	}
	f.expect(f.call("bob", "POST", path, "publish-version", `"1"`, nil), 200, "ContextVersion")
	f.expect(f.call("bob", "POST", path, "publish-version", `"1"`, nil), 200, "ContextVersion")
	f.expect(f.call("alice", "POST", path, "other-publish", `"1"`, nil), 412, "")
	ready := f.expect(f.call("bob", "POST", taskPath+"/commands", "submit-ready", `"2"`, Object{"command": "SUBMIT", "reason": "API published"}), 200, "Task")
	if ready["status"] != "READY" {
		t.Fatal("Task not ready")
	}
	var events, audits int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("publication generated %d events", events)
	}
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_records WHERE resource_id=$1`, task["id"]).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 3 {
		t.Fatalf("expected create and two submit audit records, got %d", audits)
	}
	f.pool.Close()
	var err error
	f.pool, err = pgxpool.NewWithConfig(context.Background(), f.config)
	if err != nil {
		t.Fatal(err)
	}
	f.server, err = New(f.pool, testAuth{})
	if err != nil {
		t.Fatal(err)
	}
	persisted := f.expect(f.call("alice", "GET", taskPath, "", "", nil), 200, "Task")
	if persisted["status"] != "READY" || number(persisted, "version") != 3 {
		t.Fatal("state lost after pool/service restart")
	}
	f.expect(f.call("bob", "POST", taskPath+"/commands", "cancel-task", `"3"`, Object{"command": "CANCEL", "reason": "No longer needed"}), 200, "Task")
	f.expect(f.call("bob", "POST", taskPath+"/commands", "submit-canceled", `"4"`, Object{"command": "SUBMIT", "reason": "Try again"}), 409, "")
}

func TestHumanProjectAndRoleBoundaries(t *testing.T) {
	f := setup(t)
	c, v := f.candidate("alice")
	path := "/contexts/" + textValue(c, "id") + "/versions/" + textValue(v, "id") + "/publish"
	for _, tc := range []struct {
		user string
		want int
	}{{"", 401}, {"invalid", 401}, {"agent", 403}, {"carol", 404}, {"viewer", 403}} {
		f.expect(f.call(tc.user, "POST", path, "forbidden-publish", `"1"`, nil), tc.want, "")
	}
	body := taskBody(textValue(v, "id"))
	delete(body, "owner_user_id")
	f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", "missing-owner", "", body), 400, "")
	for _, owner := range []string{"agent", "user_carol"} {
		body["owner_user_id"] = owner
		f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 422, "")
	}
	body["owner_user_id"] = "user_bob"
	body["repository_id"] = "repo_secret"
	f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 422, "")
	f.expect(f.call("alice", "GET", "/projects/project_secret/tasks", "", "", nil), 404, "")
	f.expect(f.call("alice", "POST", "/projects/project_demo/members/user_bob/changes", "revoke-bob", `"1"`, Object{"roles": []string{"MEMBER", "REVIEWER"}, "active": false}), 200, "")
	f.expect(f.call("bob", "GET", "/contexts/"+textValue(c, "id"), "", "", nil), 404, "")
	f.expect(f.call("bob", "POST", path, "revoked-publish", `"1"`, nil), 404, "")
	f.expect(f.call("alice", "POST", "/projects/project_demo/members/user_alice/changes", "last-admin", `"1"`, Object{"roles": []string{"VIEWER"}, "active": true}), 409, "")
	body = taskBody(textValue(v, "id"))
	f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 422, "")
}

func TestContextIntegrityAndConcurrentPublication(t *testing.T) {
	f := setup(t)
	c, v := f.candidate("alice")
	ctxPath := "/contexts/" + textValue(c, "id")
	bad := Object{"source_revision": "2", "content_uri": v["content_uri"], "content_digest": "sha256:" + strings.Repeat("0", 64), "media_type": "text/markdown", "change_summary": "Changed"}
	f.expect(f.call("alice", "POST", ctxPath+"/versions", "bad-digest", `"2"`, bad), 422, "")
	bad["content_uri"] = "http://169.254.169.254/latest/meta-data"
	f.expect(f.call("alice", "POST", ctxPath+"/versions", "remote-fetch", `"2"`, bad), 422, "")
	bad["content_uri"] = v["content_uri"]
	bad["content_digest"] = v["content_digest"]
	f.expect(f.call("alice", "POST", ctxPath+"/versions", "no-precondition", "", bad), 428, "")
	other, _ := f.candidate("alice")
	f.expect(f.call("alice", "GET", "/contexts/"+textValue(other, "id")+"/versions/"+textValue(v, "id"), "", "", nil), 404, "")
	path := ctxPath + "/versions/" + textValue(v, "id") + "/publish"
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes <- f.call("alice", "POST", path, fmt.Sprintf("parallel-%d", i), `"1"`, nil).Code
		}(i)
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[200] != 1 || counts[412] != 1 {
		t.Fatalf("concurrent publication: %v", counts)
	}
	_, err := f.pool.Exec(context.Background(), `UPDATE context_versions SET document=jsonb_set(document,'{source_revision}','"tampered"') WHERE id=$1`, v["id"])
	if err == nil {
		t.Fatal("database allowed version rewrite")
	}
	_, err = f.pool.Exec(context.Background(), `UPDATE context_contents SET content='tampered'`)
	if err == nil {
		t.Fatal("database allowed content rewrite")
	}
	_, err = f.pool.Exec(context.Background(), `DELETE FROM audit_records`)
	if err == nil {
		t.Fatal("database allowed audit deletion")
	}
}

func TestBoundedInputPaginationAndHealth(t *testing.T) {
	f := setup(t)
	f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?limit=101", "", "", nil), 400, "")
	f.expect(f.call("alice", "POST", "/projects/project_demo/contents", "", "", Object{"content": "x", "media_type": "text/plain"}), 400, "")
	body := Object{"content": "x", "media_type": "text/plain", "owner_user_id": "user_alice"}
	f.expect(f.call("alice", "POST", "/projects/project_demo/contents", "unknown-field", "", body), 400, "")
	for _, path := range []string{"/healthz", "/readyz"} {
		r := httptest.NewRecorder()
		f.server.ServeHTTP(r, httptest.NewRequest(http.MethodGet, path, nil))
		if r.Code != 200 {
			t.Fatalf("%s: %d", path, r.Code)
		}
	}
	c, _ := f.candidate("alice")
	f.candidate("bob")
	first := f.expect(f.call("alice", "GET", "/projects/project_demo/contexts?limit=1", "", "", nil), 200, "")
	cursor := textValue(first, "next_cursor")
	if cursor == "" {
		t.Fatal("missing continuation")
	}
	second := f.expect(f.call("alice", "GET", "/projects/project_demo/contexts?limit=1&cursor="+cursor, "", "", nil), 200, "")
	if second["next_cursor"] != nil {
		t.Fatal("extra continuation")
	}
	f.expect(f.call("alice", "GET", "/contexts/"+textValue(c, "id")+"/versions?cursor="+cursor, "", "", nil), 400, "")
}

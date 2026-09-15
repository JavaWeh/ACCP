//go:build integration

package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JavaWeh/ACCP/internal/eventbus"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

type executionFixture struct {
	*fixture
	token, session, agent string
	manifest              Object
}

func setupExecution(t *testing.T) *executionFixture {
	f := &executionFixture{fixture: setup(t)}
	var err error
	f.server, err = New(f.pool, testAuth{}, Options{SessionKey: bytes.Repeat([]byte{31}, 32), PublicURL: "http://127.0.0.1:18080"})
	if err != nil {
		t.Fatal(err)
	}
	f.manifest = Object{"adapter_id": "accp_bridge", "adapter_version": "0.2.0", "protocol_versions": []string{"0.2"}, "client": Object{"name": "integration-client", "version": "test"}, "capabilities": Object{"claim": true, "context_read": true, "artifact_report": true, "heartbeat": true, "cancel": "cooperative", "notifications": []string{"poll", "sse"}, "auto_start": false}}
	a := f.expect(f.call("bob", "POST", "/agents", newID("key"), "", Object{"project_id": "project_demo", "manifest": f.manifest}), 201, "M2AgentIdentity")
	f.agent = textValue(a, "id")
	grant := f.expect(f.call("bob", "POST", "/agent-sessions", newID("key"), "", Object{"project_id": "project_demo", "agent_id": f.agent, "scopes": []string{"tasks:read", "runs:claim", "runs:write", "context:read", "artifacts:write", "events:read"}, "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}), 201, "M2SessionGrant")
	f.token = textValue(grant, "access_token")
	f.session = textValue(grant["session"].(map[string]any), "id")
	f.expect(f.call(f.token, "POST", "/adapters/handshake", newID("key"), "", Object{"manifest": f.manifest}), 200, "M2HandshakeResponse")
	return f
}
func (f *executionFixture) readyTask() Object {
	c, v := f.candidate("bob")
	f.expect(f.call("bob", "POST", "/contexts/"+textValue(c, "id")+"/versions/"+textValue(v, "id")+"/publish", newID("key"), `"1"`, nil), 200, "ContextVersion")
	task := f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", newID("key"), "", taskBody(textValue(v, "id"))), 201, "Task")
	path := "/tasks/" + textValue(task, "id")
	f.expect(f.call("bob", "POST", path+"/assignments", newID("key"), `"1"`, Object{"target": Object{"agent_id": f.agent}}), 201, "M2Assignment")
	return f.expect(f.call("bob", "POST", path+"/commands", newID("key"), `"2"`, Object{"command": "SUBMIT", "reason": "Execute"}), 200, "Task")
}
func (f *executionFixture) claim(task Object, key string) Object {
	return f.expect(f.call(f.token, "POST", "/task-runs/claim", key, "", Object{"project_id": "project_demo", "task_id": task["id"], "base_revision": strings.Repeat("a", 40)}), 201, "M2ClaimResponse")
}
func (f *executionFixture) runWrite(token string, run Object, suffix, key string, body Object) *httptest.ResponseRecorder {
	data, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/v1/task-runs/"+textValue(run, "id")+suffix, bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)
	req.Header.Set("If-Match", fmt.Sprintf(`"%d"`, revision(run, "version")))
	req.Header.Set("X-Run-Fencing-Token", fmt.Sprint(revision(run, "fencing_token")))
	out := httptest.NewRecorder()
	f.server.ServeHTTP(out, req)
	return out
}
func (f *executionFixture) storedEvidence(run Object) Object {
	content := f.expect(f.runWrite(f.token, run, "/artifact-contents", newID("key"), Object{"content": "tests: 7 passed", "media_type": "text/plain"}), 201, "M2ArtifactContent")
	return f.expect(f.runWrite(f.token, run, "/artifacts", newID("key"), Object{"kind": "TEST_REPORT", "uri": content["uri"], "content_digest": content["content_digest"], "media_type": "text/plain"}), 201, "M2Artifact")
}
func TestM2ExecutionEvidenceAndHumanBoundary(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	claim := f.claim(task, "stable-claim-key")
	run := claim["run"].(map[string]any)
	duplicate := f.claim(task, "stable-claim-key")
	if duplicate["run"].(map[string]any)["id"] != run["id"] {
		t.Fatal("duplicate claim created a Run")
	}
	f.expect(f.call(f.token, "POST", "/projects/project_demo/tasks", newID("key"), "", taskBody("version_fake")), 403, "")
	f.expect(f.call(f.token, "POST", "/agent-sessions", newID("key"), "", Object{}), 403, "")
	f.expect(f.call(f.token, "POST", "/tasks/"+textValue(task, "id")+"/commands", newID("key"), `"4"`, Object{"command": "CANCEL", "reason": "Agent attempted human command"}), 403, "")
	snapshot := f.expect(f.call(f.token, "GET", "/context-snapshots/"+textValue(run, "context_snapshot_id"), "", "", nil), 200, "M2ContextSnapshot")
	if snapshot["content_digest"] != claim["snapshot"].(map[string]any)["content_digest"] {
		t.Fatal("snapshot drift")
	}
	progress := f.expect(f.runWrite(f.token, run, "/reports", newID("key"), Object{"kind": "PROGRESS", "progress_percent": 100, "message": "Preparing evidence"}), 200, "M2TaskRun")
	if progress["status"] != "RUNNING" {
		t.Fatal("self-reported percentage completed a Run")
	}
	run = progress
	external := f.expect(f.runWrite(f.token, run, "/artifacts", newID("key"), Object{"kind": "COMMIT", "uri": "https://example.com/commit/" + strings.Repeat("a", 40), "content_digest": "sha256:" + strings.Repeat("b", 64), "immutable_revision": strings.Repeat("a", 40), "media_type": "application/json"}), 201, "M2Artifact")
	f.expect(f.runWrite(f.token, run, "/reports", newID("key"), Object{"kind": "COMPLETION_CANDIDATE", "artifact_ids": []string{textValue(external, "id")}, "acceptance_report": "Unverified reference"}), 422, "")
	artifact := f.storedEvidence(run)
	body := Object{"kind": "COMPLETION_CANDIDATE", "artifact_ids": []string{textValue(artifact, "id")}, "acceptance_report": "See stored test evidence"}
	done := f.expect(f.runWrite(f.token, run, "/reports", "complete-stable", body), 200, "M2TaskRun")
	if done["status"] != "SUCCEEDED" {
		t.Fatal("Run did not finish")
	}
	f.expect(f.runWrite(f.token, run, "/reports", "complete-stable", body), 200, "M2TaskRun")
	task = f.expect(f.call("bob", "GET", "/tasks/"+textValue(task, "id"), "", "", nil), 200, "Task")
	if task["status"] != "IN_REVIEW" {
		t.Fatal("Agent bypassed human acceptance")
	}
	f.expect(f.runWrite(f.token, done, "/heartbeat", newID("key"), Object{"observed_at": now()}), 409, "")
	audit := f.expect(f.call("alice", "GET", "/projects/project_demo/audit-records?limit=100", "", "", nil), 200, "AuditPage")
	found := false
	for _, raw := range audit["items"].([]any) {
		a := raw.(map[string]any)
		if a["task_run_id"] == run["id"] && a["actor"].(map[string]any)["kind"] == "AGENT" {
			found = true
			if a["owner_user_id"] != "user_bob" || a["accountable_user_id"] != "user_bob" || a["context_snapshot_id"] != run["context_snapshot_id"] {
				t.Fatal("incomplete responsibility")
			}
		}
	}
	if !found {
		t.Fatal("missing Agent audit")
	}
	var leaks int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM idempotency_records WHERE body::text LIKE '%accp_s_%'`).Scan(&leaks); err != nil || leaks != 0 {
		t.Fatal("credential persisted", err)
	}
}
func TestM2ConcurrentClaimFenceCancelAndRetry(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	responses := make(chan *httptest.ResponseRecorder, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			responses <- f.call(f.token, "POST", "/task-runs/claim", newID("key"), "", Object{"project_id": "project_demo", "task_id": task["id"], "base_revision": strings.Repeat("a", 40)})
		}()
	}
	wg.Wait()
	close(responses)
	var run Object
	count := 0
	for r := range responses {
		if r.Code == 201 {
			count++
			run = f.expect(r, 201, "M2ClaimResponse")["run"].(map[string]any)
		} else {
			f.expect(r, 409, "")
		}
	}
	if count != 1 {
		t.Fatalf("active claims %d", count)
	}
	wrong := Object{}
	for k, v := range run {
		wrong[k] = v
	}
	wrong["fencing_token"] = number(run, "fencing_token") + 1
	f.expect(f.runWrite(f.token, wrong, "/heartbeat", newID("key"), Object{"observed_at": now()}), 409, "")
	failed := f.expect(f.runWrite(f.token, run, "/reports", newID("key"), Object{"kind": "FAILURE", "error_code": "TEST_FAILURE", "message": "Needs correction"}), 200, "M2TaskRun")
	if err := f.server.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	blocked := f.expect(f.call("bob", "GET", "/tasks/"+textValue(task, "id"), "", "", nil), 200, "Task")
	if blocked["status"] != "BLOCKED" {
		t.Fatal("Worker silently retried failure")
	}
	f.expect(f.call("bob", "POST", "/tasks/"+textValue(task, "id")+"/commands", newID("key"), fmt.Sprintf(`"%d"`, number(blocked, "version")), Object{"command": "RETRY", "reason": "Human authorizes a fresh attempt"}), 200, "Task")
	fresh := f.claim(task, newID("key"))["run"].(map[string]any)
	if number(fresh, "attempt") != 2 || number(fresh, "fencing_token") <= number(run, "fencing_token") || fresh["id"] == run["id"] {
		t.Fatal("retry overwrote history or reused fencing token")
	}
	f.expect(f.runWrite(f.token, failed, "/reports", newID("key"), Object{"kind": "PROGRESS", "progress_percent": 1, "message": "Late write"}), 409, "")
	current := f.expect(f.call("bob", "GET", "/tasks/"+textValue(task, "id"), "", "", nil), 200, "Task")
	f.expect(f.call("bob", "POST", "/tasks/"+textValue(task, "id")+"/commands", newID("key"), fmt.Sprintf(`"%d"`, number(current, "version")), Object{"command": "CANCEL", "reason": "Stop local execution"}), 200, "Task")
	f.expect(f.runWrite(f.token, fresh, "/heartbeat", newID("key"), Object{"observed_at": now()}), 409, "")
	canceled := f.expect(f.call(f.token, "GET", "/task-runs/"+textValue(fresh, "id"), "", "", nil), 200, "M2TaskRun")
	if canceled["status"] != "CANCELED" {
		t.Fatal("Run did not observe cancellation")
	}
}
func TestM2RevocationPreventsCachedWritesAndReaps(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	claim := f.claim(task, "claim-before-revoke")
	run := claim["run"].(map[string]any)
	heartbeat := Object{"observed_at": now()}
	f.expect(f.runWrite(f.token, run, "/heartbeat", "heartbeat-replay", heartbeat), 200, "M2HeartbeatResponse")
	grant := f.expect(f.call("bob", "GET", "/agent-sessions/"+f.session, "", "", nil), 200, "M2AgentSession")
	f.expect(f.call("bob", "POST", "/agent-sessions/"+f.session+"/revoke", newID("key"), fmt.Sprintf(`"%d"`, number(grant, "version")), Object{"reason": "Delegation withdrawn"}), 200, "M2AgentSession")
	f.expect(f.runWrite(f.token, run, "/heartbeat", "heartbeat-replay", heartbeat), 401, "")
	f.expect(f.call(f.token, "POST", "/task-runs/claim", "claim-before-revoke", "", Object{"project_id": "project_demo", "task_id": task["id"], "base_revision": strings.Repeat("a", 40)}), 401, "")
	if err := f.server.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	lost := f.expect(f.call("bob", "GET", "/task-runs/"+textValue(run, "id"), "", "", nil), 200, "M2TaskRun")
	if lost["status"] != "LOST" {
		t.Fatal("revoked execution not reconciled")
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE task_runs SET version=version+1 WHERE id=$1`, run["id"]); err == nil {
		t.Fatal("terminal Run history mutable")
	}
}
func TestM2DAGIsolationAndSnapshotImmutability(t *testing.T) {
	f := setupExecution(t)
	a, b := f.readyTask(), f.readyTask()
	f.expect(f.call("bob", "POST", "/tasks/"+textValue(b, "id")+"/dependencies", newID("key"), `"3"`, Object{"predecessor_task_id": a["id"], "condition": Object{"kind": "TASK_DONE"}}), 201, "M2TaskDependency")
	f.expect(f.call("bob", "POST", "/tasks/"+textValue(a, "id")+"/dependencies", newID("key"), `"3"`, Object{"predecessor_task_id": b["id"], "condition": Object{"kind": "TASK_DONE"}}), 409, "")
	f.expect(f.call(f.token, "POST", "/task-runs/claim", newID("key"), "", Object{"project_id": "project_demo", "task_id": b["id"], "base_revision": strings.Repeat("a", 40)}), 409, "")
	run := f.claim(a, newID("key"))["run"].(map[string]any)
	f.expect(f.call(f.token, "GET", "/projects/project_secret/tasks", "", "", nil), 404, "")
	if _, err := f.pool.Exec(context.Background(), `UPDATE context_snapshots SET document='{}' WHERE id=$1`, run["context_snapshot_id"]); err == nil {
		t.Fatal("snapshot mutable")
	}
	// Advance the authoritative Context while retaining the Run's original input.
	var contextID string
	if err := f.pool.QueryRow(context.Background(), `SELECT context_id FROM snapshot_entries WHERE snapshot_id=$1`, run["context_snapshot_id"]).Scan(&contextID); err != nil {
		t.Fatal(err)
	}
	content := f.expect(f.call("bob", "POST", "/projects/project_demo/contents", newID("key"), "", Object{"content": "Changed API", "media_type": "text/plain"}), 201, "")
	parent := f.expect(f.call("bob", "GET", "/contexts/"+contextID, "", "", nil), 200, "Context")
	v := f.expect(f.call("bob", "POST", "/contexts/"+contextID+"/versions", newID("key"), fmt.Sprintf(`"%d"`, number(parent, "version")), Object{"source_revision": "2", "content_uri": content["content_uri"], "content_digest": content["content_digest"], "media_type": "text/plain", "change_summary": "Updated"}), 201, "ContextVersion")
	f.expect(f.call("bob", "POST", "/contexts/"+contextID+"/versions/"+textValue(v, "id")+"/publish", newID("key"), `"1"`, nil), 200, "ContextVersion")
	result := f.expect(f.runWrite(f.token, run, "/heartbeat", newID("key"), Object{"observed_at": now()}), 200, "M2HeartbeatResponse")
	if result["context_update_available"] != true {
		t.Fatal("Context drift notification missing")
	}
	snapshot := f.expect(f.call(f.token, "GET", "/context-snapshots/"+textValue(run, "context_snapshot_id"), "", "", nil), 200, "M2ContextSnapshot")
	if snapshot["entries"].([]any)[0].(map[string]any)["context_version_id"] == v["id"] {
		t.Fatal("Run silently changed input")
	}
}
func TestM2EventBusReplayAndForgedEvent(t *testing.T) {
	url := os.Getenv("ACCP_TEST_NATS_URL")
	if url == "" {
		t.Fatal("integration tests require ACCP_TEST_NATS_URL")
	}
	f := setupExecution(t)
	task := f.readyTask()
	f.claim(task, newID("key"))
	ctx := context.Background()
	namespace := newID("test")
	w, err := eventbus.New(ctx, f.pool, url, "", namespace, f.server.schemas["M2Event"].Validate)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	defer js.DeleteStream(ctx, namespace)
	var expected int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM outbox_events`).Scan(&expected); err != nil {
		t.Fatal(err)
	}
	drain := func() {
		t.Helper()
		deadline := time.Now().Add(12 * time.Second)
		for time.Now().Before(deadline) {
			if err = w.RelayOne(ctx); err != nil {
				t.Fatal(err)
			}
			if err = w.ConsumeOne(ctx); err != nil {
				t.Fatal(err)
			}
			var count int
			if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM event_feed`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count == expected {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("event delivery timed out")
	}
	drain()
	page := f.expect(f.call(f.token, "GET", "/events?project_id=project_demo", "", "", nil), 200, "M2EventPage")
	if len(page["items"].([]any)) != expected {
		t.Fatal("missing feed events")
	}
	cursor := textValue(page, "next_cursor")
	next := f.expect(f.call(f.token, "GET", "/events?project_id=project_demo&cursor="+cursor, "", "", nil), 200, "M2EventPage")
	if len(next["items"].([]any)) != 0 {
		t.Fatal("cursor duplicate delivery")
	}
	f.expect(f.call(f.token, "GET", "/events?project_id=project_demo&cursor="+cursor+"x", "", "", nil), 400, "")
	event := page["items"].([]any)[0].(map[string]any)
	id := textValue(event, "id")
	f.expect(f.call("alice", "POST", "/projects/project_demo/events/"+id+"/replay", newID("key"), "", Object{"reason": "Replay a delivery"}), 202, "")
	if err = w.RelayOne(ctx); err != nil {
		t.Fatal(err)
	}
	if err = w.ConsumeOne(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM event_feed`).Scan(&count); err != nil || count != expected {
		t.Fatal("replay duplicated feed", err)
	}
	event["data"].(map[string]any)["aggregate_version"] = float64(999)
	forged, _ := json.Marshal(event)
	if _, err = js.Publish(ctx, "accp."+namespace+".events", forged); err != nil {
		t.Fatal(err)
	}
	if err = w.ConsumeOne(ctx); err == nil {
		t.Fatal("forged event accepted")
	}
}

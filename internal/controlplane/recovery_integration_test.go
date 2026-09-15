//go:build integration

package controlplane

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestM2ExpiredLeaseCannotBeRenewedOrReplayed(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	run := f.claim(task, "claim-expiry-key")["run"].(map[string]any)
	_, err := f.pool.Exec(context.Background(), `UPDATE task_runs SET lease_expires_at=now()-interval '1 second',version=version+1,document=jsonb_set(jsonb_set(document,'{lease_expires_at}',to_jsonb((now()-interval '1 second'))),'{version}',to_jsonb(version+1)) WHERE id=$1`, run["id"])
	if err != nil {
		t.Fatal(err)
	}
	expired := f.expect(f.call(f.token, "GET", "/task-runs/"+textValue(run, "id"), "", "", nil), 200, "M2TaskRun")
	f.expect(f.runWrite(f.token, expired, "/heartbeat", newID("key"), Object{"observed_at": now()}), 409, "")
	f.expect(f.call(f.token, "POST", "/task-runs/claim", "claim-expiry-key", "", Object{"project_id": "project_demo", "task_id": task["id"], "base_revision": strings.Repeat("a", 40)}), 409, "")
	if err = f.server.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	lost := f.expect(f.call("bob", "GET", "/task-runs/"+textValue(run, "id"), "", "", nil), 200, "M2TaskRun")
	if lost["status"] != "LOST" {
		t.Fatal("expired lease not reaped")
	}
}
func TestM2SessionScopeAndRunIsolation(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	run := f.claim(task, newID("key"))["run"].(map[string]any)
	grant := f.expect(f.call("bob", "POST", "/agent-sessions", newID("key"), "", Object{"project_id": "project_demo", "agent_id": f.agent, "scopes": []string{"tasks:read", "runs:write"}, "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}), 201, "M2SessionGrant")
	other := textValue(grant, "access_token")
	f.expect(f.call(other, "GET", "/task-runs/"+textValue(run, "id"), "", "", nil), 404, "")
	f.expect(f.runWrite(other, run, "/reports", newID("key"), Object{"kind": "PROGRESS", "progress_percent": 1, "message": "Attempt another Session's Run"}), 404, "")
	f.expect(f.call(other, "GET", "/events?project_id=project_demo", "", "", nil), 403, "")
	f.expect(f.call(other, "POST", "/task-runs/claim", newID("key"), "", Object{"project_id": "project_demo", "base_revision": strings.Repeat("a", 40)}), 403, "")
	if _, err := f.pool.Exec(context.Background(), `UPDATE agent_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`, grant["session"].(map[string]any)["id"]); err != nil {
		t.Fatal(err)
	}
	f.expect(f.call(other, "GET", "/tasks/"+textValue(task, "id"), "", "", nil), 401, "")
}
func TestM2SSERechecksRevocation(t *testing.T) {
	f := setupExecution(t)
	server := httptest.NewServer(f.server)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/v1/events?project_id=project_demo", nil)
	req.Header.Set("Authorization", "Bearer "+f.token)
	req.Header.Set("Accept", "text/event-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatal("SSE was not negotiated")
	}
	scanner := bufio.NewScanner(res.Body)
	if !scanner.Scan() || !strings.HasPrefix(scanner.Text(), "id: ") {
		t.Fatal("SSE page cursor missing")
	}
	session := f.expect(f.call("bob", "GET", "/agent-sessions/"+f.session, "", "", nil), 200, "M2AgentSession")
	f.expect(f.call("bob", "POST", "/agent-sessions/"+f.session+"/revoke", newID("key"), fmt.Sprintf(`"%d"`, number(session, "version")), Object{"reason": "Revoke an open stream"}), 200, "M2AgentSession")
	closed := false
	for scanner.Scan() {
		if scanner.Text() == "event: accp.closed" {
			closed = true
			break
		}
	}
	if !closed {
		t.Fatal("SSE continued after revocation", scanner.Err())
	}
}
func TestM2ExistingAcceptedArtifactReleasesDependency(t *testing.T) {
	f := setupExecution(t)
	a, b := f.readyTask(), f.readyTask()
	f.expect(f.call("bob", "POST", "/tasks/"+textValue(b, "id")+"/dependencies", newID("key"), `"3"`, Object{"predecessor_task_id": a["id"], "condition": Object{"kind": "ARTIFACT_ACCEPTED", "artifact_kind": "TEST_REPORT"}}), 201, "M2TaskDependency")
	run := f.claim(a, newID("key"))["run"].(map[string]any)
	artifact := f.storedEvidence(run)
	if err := f.server.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	blocked := f.expect(f.call("bob", "GET", "/tasks/"+textValue(b, "id"), "", "", nil), 200, "Task")
	if blocked["status"] != "BLOCKED" {
		t.Fatal("pending artifact released dependency")
	}
	// Seed an existing human-accepted fact to test the orchestrator predicate.
	// This is not an implemented M2 approval API or an end-to-end acceptance claim.
	_, err := f.pool.Exec(context.Background(), `UPDATE artifacts SET acceptance_status='ACCEPTED',document=jsonb_set(document,'{acceptance_status}','"ACCEPTED"') WHERE id=$1`, artifact["id"])
	if err != nil {
		t.Fatal(err)
	}
	if err = f.server.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	ready := f.expect(f.call("bob", "GET", "/tasks/"+textValue(b, "id"), "", "", nil), 200, "Task")
	if ready["status"] != "READY" {
		t.Fatal("accepted dependency did not release")
	}
}

//go:build integration

package controlplane

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/JavaWeh/ACCP/internal/gateway"
)

func reviewBody(run, artifact Object) Object {
	return Object{"decision": "ACCEPT", "task_run_id": run["id"], "artifacts": []Object{{"artifact_id": artifact["id"], "version": artifact["version"], "content_digest": artifact["content_digest"]}}, "acceptance_checks": []bool{true}, "reason": "Owner verified the acceptance criterion and evidence."}
}
func etagOf(doc Object) string { return fmt.Sprintf(`"%d"`, revision(doc, "version")) }
func TestM3OwnerReviewClosesTaskAndPreservesEvidence(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	run := f.claim(task, newID("key"))["run"].(map[string]any)
	artifact := f.storedEvidence(run)
	f.expect(f.runWrite(f.token, run, "/reports", newID("key"), Object{"kind": "COMPLETION_CANDIDATE", "artifact_ids": []any{artifact["id"]}, "acceptance_report": "Tests passed"}), 200, "M2TaskRun")
	path := "/tasks/" + textValue(task, "id")
	current := f.expect(f.call("bob", "GET", path, "", "", nil), 200, "Task")
	body := reviewBody(run, artifact)
	f.expect(f.call(f.token, "POST", path+"/reviews", newID("key"), etagOf(current), body), 403, "")
	f.expect(f.call("alice", "POST", path+"/reviews", newID("key"), etagOf(current), body), 403, "")
	body["acceptance_checks"] = []bool{false}
	f.expect(f.call("bob", "POST", path+"/reviews", newID("key"), etagOf(current), body), 422, "")
	body["acceptance_checks"] = []bool{true}
	key := newID("key")
	done := f.expect(f.call("bob", "POST", path+"/reviews", key, etagOf(current), body), 200, "Task")
	if done["status"] != "DONE" {
		t.Fatal("owner review did not complete task")
	}
	f.expect(f.call("bob", "POST", path+"/reviews", key, etagOf(current), body), 200, "Task")
	got := f.expect(f.call("bob", "GET", "/artifacts/"+textValue(artifact, "id"), "", "", nil), 200, "M2Artifact")
	if got["acceptance_status"] != "ACCEPTED" {
		t.Fatal("evidence not accepted")
	}
	var reviews, denials int
	if e := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM task_reviews`).Scan(&reviews); e != nil {
		t.Fatal(e)
	}
	if e := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_records WHERE result='DENIED'`).Scan(&denials); e != nil {
		t.Fatal(e)
	}
	if reviews != 1 || denials < 3 {
		t.Fatalf("review or denial audit missing: %d/%d", reviews, denials)
	}
	if _, e := f.pool.Exec(context.Background(), `UPDATE task_reviews SET document='{}'`); e == nil {
		t.Fatal("review history was mutable")
	}
	f.expect(f.call("alice", "GET", "/projects/project_demo/audit-records", "", "", nil), 200, "AuditPage")
}
func TestM3RejectedTaskRequiresNewRun(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	run := f.claim(task, newID("key"))["run"].(map[string]any)
	a := f.storedEvidence(run)
	f.expect(f.runWrite(f.token, run, "/reports", newID("key"), Object{"kind": "COMPLETION_CANDIDATE", "artifact_ids": []any{a["id"]}, "acceptance_report": "Candidate"}), 200, "M2TaskRun")
	path := "/tasks/" + textValue(task, "id")
	task = f.expect(f.call("bob", "GET", path, "", "", nil), 200, "Task")
	body := reviewBody(run, a)
	body["decision"] = "REJECT"
	body["acceptance_checks"] = []bool{false}
	rejected := f.expect(f.call("bob", "POST", path+"/reviews", newID("key"), etagOf(task), body), 200, "Task")
	if e := f.server.Reconcile(context.Background()); e != nil {
		t.Fatal(e)
	}
	task = f.expect(f.call("bob", "GET", path, "", "", nil), 200, "Task")
	if task["status"] != "BLOCKED" {
		t.Fatal("rejection automatically retried")
	}
	retried := f.expect(f.call("bob", "POST", path+"/commands", newID("key"), etagOf(rejected), Object{"command": "RETRY", "reason": "Address review feedback"}), 200, "Task")
	fresh := f.claim(retried, newID("key"))["run"].(map[string]any)
	if fresh["id"] == run["id"] {
		t.Fatal("retry overwrote old Run")
	}
}
func TestM3AcceptedAPIReleasesDependency(t *testing.T) {
	f := setupExecution(t)
	backend := f.readyTask()
	frontend := f.readyTask()
	path := "/tasks/" + textValue(frontend, "id")
	f.expect(f.call("bob", "POST", path+"/dependencies", newID("key"), etagOf(frontend), Object{"predecessor_task_id": backend["id"], "condition": Object{"kind": "ARTIFACT_ACCEPTED", "artifact_kind": "API_DOCUMENT"}}), 201, "M2TaskDependency")
	run := f.claim(backend, newID("key"))["run"].(map[string]any)
	upload := f.expect(f.runWrite(f.token, run, "/artifact-contents", newID("key"), Object{"content": "# Orders\nGET /orders", "media_type": "text/markdown"}), 201, "M2ArtifactContent")
	a := f.expect(f.runWrite(f.token, run, "/artifacts", newID("key"), Object{"kind": "API_DOCUMENT", "uri": upload["uri"], "content_digest": upload["content_digest"], "media_type": "text/markdown", "context_version_id": backend["context_version_ids"].([]any)[0]}), 201, "M2Artifact")
	f.expect(f.call("bob", "POST", "/artifacts/"+textValue(a, "id")+"/reviews", newID("key"), etagOf(a), Object{"decision": "ACCEPT", "content_digest": a["content_digest"], "reason": "Published API verified"}), 200, "M2Artifact")
	if e := f.server.Reconcile(context.Background()); e != nil {
		t.Fatal(e)
	}
	task := f.expect(f.call("bob", "GET", path, "", "", nil), 200, "Task")
	if task["status"] != "READY" {
		t.Fatal("accepted API did not release dependency")
	}
	dependent := f.claim(task, newID("key"))
	snapshot := dependent["snapshot"].(map[string]any)
	if len(snapshot["artifact_refs"].([]any)) != 1 || len(snapshot["entries"].([]any)) != 2 {
		t.Fatal("accepted API version was not frozen in downstream snapshot")
	}
	var n int
	if e := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE event->>'type'='io.accp.API_READY.v1'`).Scan(&n); e != nil || n != 1 {
		t.Fatalf("missing API_READY: %d %v", n, e)
	}
}
func setupTools(t *testing.T) (*executionFixture, *atomic.Int32) {
	t.Helper()
	f := setupExecution(t)
	config := []Object{{"id": "tool_test", "project_id": "project_demo", "resource_id": "resource_test", "kind": "mcp", "version": "1", "endpoint": "http://127.0.0.1:9999/mcp", "tool_name": "test_write", "read_only": false, "input_schema": Object{"type": "object", "properties": Object{"value": Object{"type": "string"}}, "required": []string{"value"}, "additionalProperties": false}}}
	data, _ := json.Marshal(config)
	path := filepath.Join(t.TempDir(), "tools.json")
	if e := os.WriteFile(path, data, 0600); e != nil {
		t.Fatal(e)
	}
	tools, e := gateway.Load(path, true)
	if e != nil {
		t.Fatal(e)
	}
	calls := &atomic.Int32{}
	tools.ExecuteOverride = func(context.Context, *gateway.Backend, map[string]any, string, string) (map[string]any, error) {
		calls.Add(1)
		return Object{"state": "SUCCEEDED"}, nil
	}
	f.server.options.Tools = tools
	if _, e = f.pool.Exec(context.Background(), `UPDATE agent_sessions SET scopes=array_append(scopes,'tools:invoke') WHERE id=$1`, f.session); e != nil {
		t.Fatal(e)
	}
	return f, calls
}
func toolIntent(f *executionFixture) (Object, Object, Object) {
	f.t.Helper()
	policy := f.expect(f.call("alice", "POST", "/projects/project_demo/tools", newID("key"), "", Object{"backend_id": "tool_test", "name": "Write test resource", "resource_version": "rev1", "enabled": true, "reason": "Approved tool registration"}), 201, "M3Policy")
	task := f.readyTask()
	run := f.claim(task, newID("key"))["run"].(map[string]any)
	invocation := f.expect(f.runWrite(f.token, run, "/tool-invocations", newID("key"), Object{"tool_id": policy["id"], "resource_version": "rev1", "arguments": Object{"value": "approved"}, "artifact_ids": []any{}}), 201, "M3Invocation")
	return policy, run, invocation
}
func TestM3IndependentApprovalAndExactlyOneIntent(t *testing.T) {
	f, calls := setupTools(t)
	_, _, inv := toolIntent(f)
	approval := f.expect(f.call("alice", "GET", "/approvals/"+textValue(inv, "approval_id"), "", "", nil), 200, "M3Approval")
	body := Object{"decision": "APPROVE", "binding_digest": approval["binding_digest"], "reason": "Reviewed target and exact arguments"}
	path := "/approvals/" + textValue(approval, "id") + "/decisions"
	f.expect(f.call(f.token, "POST", path, newID("key"), etagOf(approval), body), 403, "")
	f.expect(f.call("bob", "POST", path, newID("key"), etagOf(approval), body), 403, "")
	if e := f.server.ProcessTools(context.Background()); e != nil {
		t.Fatal(e)
	}
	if calls.Load() != 0 {
		t.Fatal("executed before approval")
	}
	f.expect(f.call("alice", "POST", path, newID("key"), etagOf(approval), body), 200, "M3Approval")
	for i := 0; i < 2; i++ {
		if e := f.server.ProcessTools(context.Background()); e != nil {
			t.Fatal(e)
		}
	}
	got := f.expect(f.call(f.token, "GET", "/tool-invocations/"+textValue(inv, "id"), "", "", nil), 200, "M3Invocation")
	if calls.Load() != 1 || got["status"] != "SUCCEEDED" {
		t.Fatalf("unexpected effects: %d %v", calls.Load(), got)
	}
	if _, e := f.pool.Exec(context.Background(), `UPDATE tool_invocations SET document=jsonb_set(document,'{parameters,value}','"tampered"') WHERE id=$1`, inv["id"]); e == nil {
		t.Fatal("invocation parameters mutable")
	}
}
func TestM3PolicyChangeAndRevocationCancelApprovedWork(t *testing.T) {
	for _, change := range []string{"policy", "session", "lease"} {
		t.Run(change, func(t *testing.T) {
			f, calls := setupTools(t)
			policy, run, inv := toolIntent(f)
			f.expect(f.call("alice", "POST", "/approvals/"+textValue(inv, "approval_id")+"/decisions", newID("key"), `"1"`, Object{"decision": "APPROVE", "binding_digest": inv["binding_digest"], "reason": "Approved exact operation"}), 200, "M3Approval")
			switch change {
			case "policy":
				f.expect(f.call("alice", "POST", "/tools/"+textValue(policy, "id")+"/changes", newID("key"), etagOf(policy), Object{"backend_id": "tool_test", "name": "Changed resource", "resource_version": "rev2", "enabled": true, "reason": "Target revision changed"}), 200, "M3Policy")
			case "session":
				f.expect(f.call("bob", "POST", "/agent-sessions/"+f.session+"/revoke", newID("key"), `"2"`, Object{"reason": "Revoke operation authority"}), 200, "M2AgentSession")
			case "lease":
				_, e := f.pool.Exec(context.Background(), `UPDATE task_runs SET lease_expires_at=now()-interval '1 second', version=version+1,document=jsonb_set(jsonb_set(document,'{version}',to_jsonb(version+1)),'{lease_expires_at}',to_jsonb(to_char(now()-interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE id=$1`, run["id"])
				if e != nil {
					t.Fatal(e)
				}
			}
			if e := f.server.ProcessTools(context.Background()); e != nil {
				t.Fatal(e)
			}
			got := f.expect(f.call("alice", "GET", "/tool-invocations/"+textValue(inv, "id"), "", "", nil), 200, "M3Invocation")
			if calls.Load() != 0 || got["status"] != "CANCELED" {
				t.Fatal("stale authority executed")
			}
		})
	}
}

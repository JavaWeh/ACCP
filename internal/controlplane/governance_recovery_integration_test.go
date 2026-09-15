//go:build integration

package controlplane

import (
	"context"
	"errors"
	"github.com/JavaWeh/ACCP/internal/gateway"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestM3UnknownOperationBlocksAcceptanceAndRetry(t *testing.T) {
	f, _ := setupTools(t)
	_, run, inv := toolIntent(f)
	artifact := f.storedEvidence(run)
	f.server.options.Tools.ExecuteOverride = func(context.Context, *gateway.Backend, map[string]any, string, string) (map[string]any, error) {
		return nil, errors.New("uncertain")
	}
	f.expect(f.call("alice", "POST", "/approvals/"+textValue(inv, "approval_id")+"/decisions", newID("key"), `"1"`, Object{"decision": "APPROVE", "binding_digest": inv["binding_digest"], "reason": "Reviewed exact operation"}), 200, "M3Approval")
	if e := f.server.ProcessTools(context.Background()); e != nil {
		t.Fatal(e)
	}
	f.expect(f.runWrite(f.token, run, "/reports", newID("key"), Object{"kind": "COMPLETION_CANDIDATE", "artifact_ids": []any{artifact["id"]}, "acceptance_report": "Candidate with unresolved operation"}), 200, "M2TaskRun")
	path := "/tasks/" + textValue(run, "task_id")
	task := f.expect(f.call("bob", "GET", path, "", "", nil), 200, "Task")
	body := reviewBody(run, artifact)
	f.expect(f.call("bob", "POST", path+"/reviews", newID("key"), etagOf(task), body), 409, "")
	body["decision"] = "REJECT"
	rejected := f.expect(f.call("bob", "POST", path+"/reviews", newID("key"), etagOf(task), body), 200, "Task")
	f.expect(f.call("bob", "POST", path+"/commands", newID("key"), etagOf(rejected), Object{"command": "RETRY", "reason": "Try again"}), 409, "")
}

func TestM3CrashedIntentBecomesUnknownWithoutAnotherEffect(t *testing.T) {
	f, calls := setupTools(t)
	_, _, inv := toolIntent(f)
	f.expect(f.call("alice", "POST", "/approvals/"+textValue(inv, "approval_id")+"/decisions", newID("key"), `"1"`, Object{"decision": "APPROVE", "binding_digest": inv["binding_digest"], "reason": "Reviewed operation"}), 200, "M3Approval")
	_, e := f.pool.Exec(context.Background(), `UPDATE tool_invocations SET status='RUNNING',started_at=now()-interval '1 minute',document=jsonb_set(jsonb_set(document,'{status}','"RUNNING"'),'{version}',to_jsonb((document->>'version')::bigint+1)) WHERE id=$1`, inv["id"])
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		if e = f.server.ProcessTools(context.Background()); e != nil {
			t.Fatal(e)
		}
	}
	got := f.expect(f.call("alice", "GET", "/tool-invocations/"+textValue(inv, "id"), "", "", nil), 200, "M3Invocation")
	if got["status"] != "UNKNOWN" || calls.Load() != 0 {
		t.Fatal("crashed operation repeated")
	}
}

func TestM3GatewayDeniedKnownIdentityIsAudited(t *testing.T) {
	f, _ := setupTools(t)
	grant := f.expect(f.call(f.token, "GET", "/agent-sessions/"+f.session+"/gateway-token", "", "", nil), 200, "M3GatewayGrant")
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+textValue(grant, "access_token"))
	req.Header.Set("Origin", "https://untrusted.example")
	res := httptest.NewRecorder()
	f.server.ServeHTTP(res, req)
	if res.Code != 403 {
		t.Fatal("unexpected status")
	}
	var n int
	if e := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_records WHERE actor_session_id=$1 AND result='DENIED' AND details->>'error_code'='ORIGIN_DENIED'`, f.session).Scan(&n); e != nil || n != 1 {
		t.Fatal("gateway denial lost", e, n)
	}
}

func TestM3StaleApprovalBindingAndRejectionCannotExecute(t *testing.T) {
	f, calls := setupTools(t)
	_, _, inv := toolIntent(f)
	path := "/approvals/" + textValue(inv, "approval_id") + "/decisions"
	f.expect(f.call("alice", "POST", path, newID("key"), `"1"`, Object{"decision": "APPROVE", "binding_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "reason": "Wrong binding"}), 412, "")
	f.expect(f.call("alice", "POST", path, newID("key"), `"1"`, Object{"decision": "REJECT", "binding_digest": inv["binding_digest"], "reason": "Reject operation"}), 200, "M3Approval")
	if e := f.server.ProcessTools(context.Background()); e != nil {
		t.Fatal(e)
	}
	if calls.Load() != 0 {
		t.Fatal("rejected operation executed")
	}
}

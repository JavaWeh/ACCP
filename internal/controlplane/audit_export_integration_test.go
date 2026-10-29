//go:build integration

package controlplane

import (
	"context"
	"strings"
	"testing"
)

// TestAuditFilterExportAndRedaction exercises the F4 server-side filters, the
// redacted JSONL/CSV export, the ADMIN role matrix, and the organization
// cross-project view. Audit rows are inserted directly so a bogus secret can be
// planted in the details jsonb and asserted absent from every download.
func TestAuditFilterExportAndRedaction(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	var org string
	if err := f.pool.QueryRow(ctx, `SELECT organization_id FROM projects WHERE id='project_demo'`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	insert := func(id, actor, action, details string) {
		if _, err := f.pool.Exec(ctx, `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,action,resource_id,resource_version,trace_id,actor_kind,result,details) VALUES($1,'project_demo',$2,$3,$4,'task_demo',0,'trace_x','HUMAN','SUCCEEDED',$5)`, id, org, actor, action, details); err != nil {
			t.Fatal(err)
		}
	}
	insert("audit_alice_1", "user_alice", "POST /api/v1/x", `{"secret_token":"LEAK","approval_id":"approval_x"}`)
	insert("audit_bob_1", "user_bob", "POST /api/v1/y", `{}`)

	// Server-side actor filter returns only matching rows (and resets cleanly).
	page := f.expect(f.call("alice", "GET", "/projects/project_demo/audit-records?actor=user_bob", "", "", nil), 200, "AuditPage")
	items, _ := page["items"].([]any)
	if len(items) == 0 {
		t.Fatal("actor filter returned nothing")
	}
	for _, it := range items {
		if row, _ := it.(map[string]any); row["accountable_user_id"] != "user_bob" {
			t.Fatalf("actor filter leaked %v", row["accountable_user_id"])
		}
	}

	// Project export (ADMIN) is redacted: whitelisted detail survives, the raw
	// key never leaks, and an attachment is offered.
	export := f.call("alice", "GET", "/projects/project_demo/audit-records/export?format=jsonl", "", "", nil)
	if export.Code != 200 {
		t.Fatalf("export status %d: %s", export.Code, export.Body.String())
	}
	if cd := export.Header().Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
		t.Fatalf("missing attachment disposition: %q", cd)
	}
	if body := export.Body.String(); strings.Contains(body, "LEAK") || strings.Contains(body, "secret_token") {
		t.Fatalf("jsonl export leaked raw details: %s", body)
	} else if !strings.Contains(body, "approval_x") {
		t.Fatalf("jsonl export dropped whitelisted detail: %s", body)
	}

	csv := f.call("alice", "GET", "/projects/project_demo/audit-records/export?format=csv", "", "", nil)
	if csv.Code != 200 || !strings.HasPrefix(csv.Body.String(), "id,occurred_at") {
		t.Fatalf("csv export malformed: %d %q", csv.Code, csv.Body.String())
	}
	if strings.Contains(csv.Body.String(), "LEAK") {
		t.Fatal("csv export leaked secret")
	}

	// Each successful export wrote its own audit row (filter summary + hash).
	var exports int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM audit_records WHERE project_id='project_demo' AND action LIKE '%audit-records/export' AND result='SUCCEEDED'`).Scan(&exports); err != nil {
		t.Fatal(err)
	}
	if exports < 2 {
		t.Fatalf("expected an audit row per export, got %d", exports)
	}

	// Role matrix: REVIEWER lists but cannot export; VIEWER sees neither.
	f.expect(f.call("bob", "GET", "/projects/project_demo/audit-records", "", "", nil), 200, "AuditPage")
	f.expect(f.call("bob", "GET", "/projects/project_demo/audit-records/export", "", "", nil), 403, "")
	f.expect(f.call("viewer", "GET", "/projects/project_demo/audit-records", "", "", nil), 403, "")
	f.expect(f.call("viewer", "GET", "/projects/project_demo/audit-records/export", "", "", nil), 403, "")

	// Organization cross-project execution audit + export are org-ADMIN only.
	f.expect(f.call("alice", "GET", "/organization/execution-audit-records", "", "", nil), 200, "AuditPage")
	f.expect(f.call("bob", "GET", "/organization/execution-audit-records", "", "", nil), 403, "")
	f.expect(f.call("carol", "GET", "/organization/execution-audit-records", "", "", nil), 403, "")
	orgExport := f.call("alice", "GET", "/organization/execution-audit-records/export?format=jsonl", "", "", nil)
	if orgExport.Code != 200 || strings.Contains(orgExport.Body.String(), "LEAK") {
		t.Fatalf("org export failed or leaked: %d", orgExport.Code)
	}
	f.expect(f.call("bob", "GET", "/organization/execution-audit-records/export", "", "", nil), 403, "")
}

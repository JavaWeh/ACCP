//go:build integration

package controlplane

import (
	"context"
	"github.com/JavaWeh/ACCP/internal/recovery"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectAuditExportAndLocalEvidenceCleanup(t *testing.T) {
	f := setupExecution(t)
	_, v := f.candidate("bob")
	f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", "handoff-task-key", "", taskBody(textValue(v, "id"))), 201, "Task")
	for _, actor := range []string{"bob", "viewer", f.token} {
		f.expect(f.call(actor, "GET", "/projects/project_demo/audit-export?limit=25", "", "", nil), 403, "")
	}
	f.expect(f.call("carol", "GET", "/projects/project_demo/audit-export?limit=25", "", "", nil), 404, "")
	f.expect(f.call("alice", "GET", "/projects/project_demo/audit-export?limit=25", "", "", nil), 200, "")
	ctx := context.Background()
	var before int
	f.pool.QueryRow(ctx, `SELECT count(*) FROM tasks`).Scan(&before)
	_, err := f.pool.Exec(ctx, `UPDATE idempotency_records SET expires_at=now()-interval '1 second' WHERE key='handoff-task-key'`)
	if err != nil {
		t.Fatal(err)
	}
	databaseURL, _ := url.Parse(f.config.ConnString())
	query := databaseURL.Query()
	query.Set("search_path", f.config.ConnConfig.RuntimeParams["search_path"])
	databaseURL.RawQuery = query.Encode()
	args := func(action, output, actor string, execute bool) error {
		return recovery.Handoff(ctx, databaseURL.String(), action, output, actor, "project_demo", "Handoff test", execute)
	}
	directory := t.TempDir()
	if args("audit-export", filepath.Join(directory, "denied"), "user_bob", false) == nil {
		t.Fatal("non-admin export allowed")
	}
	export := filepath.Join(directory, "audit.ndjson")
	if err = args("audit-export", export, "user_alice", false); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(export)
	if !strings.Contains(string(raw), "REPEATABLE READ") || !strings.Contains(string(raw), "actor_user_id") {
		t.Fatal("missing export provenance")
	}
	if args("audit-export", export, "user_alice", false) == nil {
		t.Fatal("export overwrote file")
	}
	diagnostic := filepath.Join(directory, "diagnostic.json")
	if err = args("diagnostics", diagnostic, "user_alice", false); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(diagnostic)
	if strings.Contains(string(raw), f.token) || strings.Contains(string(raw), "Orders API") {
		t.Fatal("diagnostic leaked content or credentials")
	}
	if err = args("cleanup", "", "user_alice", false); err != nil {
		t.Fatal(err)
	}
	var count int
	f.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_records WHERE key='handoff-task-key'`).Scan(&count)
	if count != 1 {
		t.Fatal("preview deleted key")
	}
	if err = args("cleanup", "", "user_alice", true); err != nil {
		t.Fatal(err)
	}
	f.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_records WHERE key='handoff-task-key'`).Scan(&count)
	if count != 0 {
		t.Fatal("expired key not removed")
	}
	var after int
	f.pool.QueryRow(ctx, `SELECT count(*) FROM tasks`).Scan(&after)
	if after != before {
		t.Fatal("cleanup changed business evidence")
	}
	f.pool.QueryRow(ctx, `SELECT count(*) FROM audit_records WHERE action='LOCAL_CLEANUP'`).Scan(&count)
	if count != 1 {
		t.Fatal("cleanup not audited")
	}
}

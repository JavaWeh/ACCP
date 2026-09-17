//go:build integration

package controlplane

import (
	"context"
	"github.com/JavaWeh/ACCP/internal/recovery"
	"testing"
)

func TestRestoreQuarantinesRealRunAndSideEffectLedger(t *testing.T) {
	f, calls := setupTools(t)
	_, run, inv := toolIntent(f)
	ctx := context.Background()
	artifact := f.storedEvidence(run)
	var before string
	if err := f.pool.QueryRow(ctx, `SELECT document::text FROM context_snapshots WHERE id=$1`, run["context_snapshot_id"]).Scan(&before); err != nil {
		t.Fatal(err)
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = recovery.Quarantine(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	f.expect(f.call(f.token, "GET", "/task-runs/"+textValue(run, "id"), "", "", nil), 401, "")
	if err = f.server.ProcessTools(ctx); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 {
		t.Fatal("restored operation executed automatically")
	}
	got := f.expect(f.call("alice", "GET", "/tool-invocations/"+textValue(inv, "id"), "", "", nil), 200, "M3Invocation")
	if got["status"] != "UNKNOWN" || got["binding_digest"] != inv["binding_digest"] {
		t.Fatal("restored ledger identity changed", got)
	}
	var after, runStatus, owner string
	var n int
	var paused, retry bool
	if err = f.pool.QueryRow(ctx, `SELECT document::text FROM context_snapshots WHERE id=$1`, run["context_snapshot_id"]).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("restored snapshot changed")
	}
	if err = f.pool.QueryRow(ctx, `SELECT status,document->>'owner_user_id' FROM task_runs WHERE id=$1`, run["id"]).Scan(&runStatus, &owner); err != nil {
		t.Fatal(err)
	}
	if runStatus != "LOST" || owner != run["owner_user_id"] {
		t.Fatal("run was not closed with original responsibility")
	}
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM artifacts WHERE id=$1`, artifact["id"]).Scan(&n); err != nil || n != 1 {
		t.Fatal("artifact missing", err)
	}
	if err = f.pool.QueryRow(ctx, `SELECT maintenance FROM runtime_state`).Scan(&paused); err != nil || !paused {
		t.Fatal("restore resumed writes", err)
	}
	if err = f.pool.QueryRow(ctx, `SELECT retry_authorized FROM tasks WHERE id=$1`, run["task_id"]).Scan(&retry); err != nil || retry {
		t.Fatal("restore authorized a retry", err)
	}
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM recovery_items WHERE resolved_at IS NULL`).Scan(&n); err != nil || n != 2 {
		t.Fatal("missing manual reconciliation items", n, err)
	}
	// The original external lookup remains callable during maintenance, but an
	// unknown outcome remains a conflict and is not converted to a blind retry.
	f.expect(f.call("alice", "POST", "/tool-invocations/"+textValue(inv, "id")+"/reconcile", newID("key"), etagOf(got), Object{"reason": "Verify restored external outcome"}), 409, "")
}

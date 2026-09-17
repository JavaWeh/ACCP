//go:build integration

package controlplane

import (
	"context"
	"github.com/JavaWeh/ACCP/internal/database"
	"testing"
	"time"
)

func TestMaintenanceBlocksWritesAndWorkers(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `UPDATE runtime_state SET maintenance=true`); err != nil {
		t.Fatal(err)
	}
	f.expect(f.call("alice", "GET", "/projects/project_demo/tasks", "", "", nil), 200, "")
	body := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", "maintenance-test", "", Object{}), 503, "")
	if body["code"] != "MAINTENANCE" {
		t.Fatal(body)
	}
	if err := f.server.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	q, err := f.server.invocationTransaction(ctx, "project_demo", "org_demo")
	if q != nil || err == nil {
		t.Fatal("worker acquired execution transaction during maintenance")
	}
}

func TestMaintenanceGateWaitsForRuntimeTransaction(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	allowed, err := database.RuntimeAllowed(ctx, tx)
	if err != nil || !allowed {
		t.Fatal(allowed, err)
	}
	deadline, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, err = f.pool.Exec(deadline, `UPDATE runtime_state SET maintenance=true`); err == nil {
		t.Fatal("maintenance overtook active execution")
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(ctx, `UPDATE runtime_state SET maintenance=true`); err != nil {
		t.Fatal(err)
	}
}

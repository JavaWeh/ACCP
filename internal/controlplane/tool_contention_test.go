//go:build integration

package controlplane

import (
	"context"
	"github.com/jackc/pgx/v5"
	"testing"
	"time"
)

func TestCommittedToolIntentWaitsForAuthorityLock(t *testing.T) {
	f, calls := setupTools(t)
	_, _, inv := toolIntent(f)
	f.expect(f.call("alice", "POST", "/approvals/"+textValue(inv, "approval_id")+"/decisions", newID("key"), `"1"`, Object{"decision": "APPROVE", "binding_digest": inv["binding_digest"], "reason": "Approved exact operation"}), 200, "M3Approval")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	locker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Rollback(ctx)
	if _, err = locker.Exec(ctx, `SELECT id FROM projects WHERE id='project_demo' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	// Discovery can skip a busy project, but the post-intent boundary must wait.
	if _, err = f.server.invocationTransaction(ctx, "project_demo", "org_demo"); err != pgx.ErrNoRows {
		t.Fatalf("discovery did not skip: %v", err)
	}
	type result struct {
		request *request
		err     error
	}
	ch := make(chan result, 1)
	go func() {
		q, e := f.server.invocationTransaction(ctx, "project_demo", "org_demo", true)
		ch <- result{q, e}
	}()
	select {
	case got := <-ch:
		if got.request != nil {
			got.request.tx.Rollback(ctx)
		}
		t.Fatalf("effect boundary skipped busy project: %v", got.err)
	case <-time.After(100 * time.Millisecond):
	}
	if err = locker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-ch
	if got.err != nil {
		t.Fatal(got.err)
	}
	got.request.tx.Rollback(ctx)
	for i := 0; i < 2; i++ {
		if err = f.server.ProcessTools(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("expected exactly one effect, got %d", calls.Load())
	}
}

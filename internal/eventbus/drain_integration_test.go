//go:build integration

package eventbus

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/JavaWeh/ACCP/internal/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestDrainDeliversBacklogInOneTick proves the per-tick drain (relayBatch /
// consumeBatch) clears a multi-row outbox backlog, rather than one row per
// 250ms tick which paced W0 event-visibility P95 to ~5s. Requires a Postgres
// (ACCP_TEST_DATABASE_URL) and a NATS/JetStream server (ACCP_TEST_NATS_URL).
func TestDrainDeliversBacklogInOneTick(t *testing.T) {
	dbURL := os.Getenv("ACCP_TEST_DATABASE_URL")
	natsURL := os.Getenv("ACCP_TEST_NATS_URL")
	if dbURL == "" || natsURL == "" {
		t.Skip("integration test requires ACCP_TEST_DATABASE_URL and ACCP_TEST_NATS_URL")
	}
	ctx := context.Background()
	pool := newSchemaPool(t, ctx, dbURL)

	const org, project = "org_drain", "proj_drain"
	mustExec(t, ctx, pool, `INSERT INTO organizations(id,name) VALUES($1,'Drain')`, org)
	mustExec(t, ctx, pool, `INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Drain')`, project, org)

	const backlog = 50
	for i := 0; i < backlog; i++ {
		id := fmt.Sprintf("evt_drain_%03d", i)
		event, _ := json.Marshal(map[string]any{"id": id, "type": "io.accp.TEST.v1", "data": map[string]any{"n": i}})
		mustExec(t, ctx, pool, `INSERT INTO outbox_events(id,project_id,organization_id,event) VALUES($1,$2,$3,$4)`, id, project, org, event)
	}

	namespace := fmt.Sprintf("drain%d", time.Now().UnixNano())
	w, err := New(ctx, pool, natsURL, "", namespace, func(any) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	defer func() {
		del, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = w.js.DeleteStream(del, namespace)
	}()

	// A single relayBatch call must publish the entire backlog, not one row.
	step, cancel := context.WithTimeout(ctx, 10*time.Second)
	if err = w.relayBatch(step); err != nil {
		cancel()
		t.Fatal("relayBatch:", err)
	}
	cancel()
	if undelivered := countRow(t, ctx, pool, `SELECT count(*) FROM outbox_events WHERE delivered_at IS NULL`); undelivered != 0 {
		t.Fatalf("relayBatch left %d/%d outbox rows undelivered (one-per-tick regression)", undelivered, backlog)
	}

	// The first consumeBatch call must persist more than one message, proving it
	// drains rather than handling a single message per tick.
	step, cancel = context.WithTimeout(ctx, 10*time.Second)
	err = w.consumeBatch(step)
	cancel()
	if err != nil {
		t.Fatal("consumeBatch:", err)
	}
	if first := countRow(t, ctx, pool, `SELECT count(*) FROM event_feed`); first <= 1 {
		t.Fatalf("first consumeBatch persisted %d feed rows; expected a drained batch >1", first)
	}

	// Remaining messages (if JetStream had not yet surfaced all of them) drain on
	// subsequent ticks; bound the wait so a hang fails instead of blocking.
	deadline := time.Now().Add(10 * time.Second)
	for countRow(t, ctx, pool, `SELECT count(*) FROM event_feed`) < backlog {
		if time.Now().After(deadline) {
			t.Fatalf("feed reached %d/%d before deadline", countRow(t, ctx, pool, `SELECT count(*) FROM event_feed`), backlog)
		}
		step, cancel = context.WithTimeout(ctx, 10*time.Second)
		err = w.consumeBatch(step)
		cancel()
		if err != nil {
			t.Fatal("consumeBatch drain:", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if feed := countRow(t, ctx, pool, `SELECT count(*) FROM event_feed`); feed != backlog {
		t.Fatalf("feed has %d rows, want %d", feed, backlog)
	}

	// Re-draining is idempotent: no duplicate feed rows, no error.
	step, cancel = context.WithTimeout(ctx, 10*time.Second)
	if err = w.relayBatch(step); err != nil {
		cancel()
		t.Fatal("relayBatch replay:", err)
	}
	err = w.consumeBatch(step)
	cancel()
	if err != nil {
		t.Fatal("consumeBatch replay:", err)
	}
	if feed := countRow(t, ctx, pool, `SELECT count(*) FROM event_feed`); feed != backlog {
		t.Fatalf("re-drain duplicated feed: %d rows, want %d", feed, backlog)
	}
}

func newSchemaPool(t *testing.T, ctx context.Context, url string) *pgxpool.Pool {
	t.Helper()
	admin, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("evbus_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	if err = database.Migrate(ctx, pool); err != nil {
		pool.Close()
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, err := admin.Exec(context.Background(), `DROP SCHEMA `+pgx.Identifier{schema}.Sanitize()+` CASCADE`)
		if err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	return pool
}

func mustExec(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		t.Fatal(err)
	}
}

func countRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, sql).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

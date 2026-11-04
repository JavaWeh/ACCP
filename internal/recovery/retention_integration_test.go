//go:build integration

package recovery

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// TestPlanRetentionCounts builds an isolated schema with event_feed and
// notifications rows straddling the 7-day window and asserts the plan counts
// candidates precisely, splits notifications by read state, and reports the
// reference guards. It never deletes a row.
func TestPlanRetentionCounts(t *testing.T) {
	ctx := context.Background()
	url := os.Getenv("ACCP_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("integration tests require ACCP_TEST_DATABASE_URL")
	}
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)

	schema := fmt.Sprintf("retention_chk_%08x", rand.Uint32())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = db.Exec(ctx, `CREATE SCHEMA `+quoted); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(ctx, `DROP SCHEMA `+quoted+` CASCADE`)

	if _, err = db.Exec(ctx, `SET search_path=`+schema); err != nil {
		t.Fatal(err)
	}
	// Minimal shapes: only the columns the plan reads. No FK to outbox_events or
	// memberships, so notifications_no_dependents is expected to be 0.
	if _, err = db.Exec(ctx, `CREATE TABLE event_feed(sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, recorded_at timestamptz NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `CREATE TABLE notifications(id text PRIMARY KEY, occurred_at timestamptz NOT NULL, read_at timestamptz)`); err != nil {
		t.Fatal(err)
	}
	// event_feed: 2 old (candidates), 3 recent.
	if _, err = db.Exec(ctx, `INSERT INTO event_feed(recorded_at) VALUES
		(now()-interval '30 days'),(now()-interval '8 days'),
		(now()-interval '1 day'),(now()-interval '2 days'),(now())`); err != nil {
		t.Fatal(err)
	}
	// notifications: 3 old (2 unread, 1 read), 1 recent.
	if _, err = db.Exec(ctx, `INSERT INTO notifications(id,occurred_at,read_at) VALUES
		('a',now()-interval '10 days',NULL),
		('b',now()-interval '9 days',NULL),
		('c',now()-interval '8 days',now()),
		('d',now()-interval '1 day',NULL)`); err != nil {
		t.Fatal(err)
	}

	plan, err := planRetention(ctx, db, schema)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.DryRun {
		t.Fatal("plan must be dry-run")
	}
	ef, nt := plan.Tables[0], plan.Tables[1]
	if ef.Total != 5 || ef.Candidates != 2 {
		t.Fatalf("event_feed total/candidates = %d/%d, want 5/2", ef.Total, ef.Candidates)
	}
	if nt.Total != 4 || nt.Candidates != 3 {
		t.Fatalf("notifications total/candidates = %d/%d, want 4/3", nt.Total, nt.Candidates)
	}
	if nt.Unread == nil || *nt.Unread != 2 || nt.Read == nil || *nt.Read != 1 {
		t.Fatalf("notifications unread/read = %v/%v, want 2/1", nt.Unread, nt.Read)
	}
	if plan.WouldDeleteTotal != 5 {
		t.Fatalf("would_delete_total = %d, want 5", plan.WouldDeleteTotal)
	}
	for _, g := range plan.Guards {
		if g.Name == "notifications_no_dependents" && g.Count != 0 {
			t.Fatalf("expected 0 dependents on isolated notifications, got %d", g.Count)
		}
		if g.Name == "outbox_events_retained" && g.Count != ef.Candidates {
			t.Fatalf("outbox guard count = %d, want %d", g.Count, ef.Candidates)
		}
	}

	// No row was deleted by planning.
	var feedRows, notifRows int64
	if err = db.QueryRow(ctx, `SELECT count(*) FROM event_feed`).Scan(&feedRows); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM notifications`).Scan(&notifRows); err != nil {
		t.Fatal(err)
	}
	if feedRows != 5 || notifRows != 4 {
		t.Fatalf("rows changed by planning: feed=%d notif=%d", feedRows, notifRows)
	}
}

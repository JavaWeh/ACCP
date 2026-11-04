package recovery

import (
	"testing"
	"time"
)

// TestAssemblePlanCountsAndSplit verifies the pure assembly: dry-run flag,
// candidate summing, the notifications unread/read split, and that event_feed
// carries no such split.
func TestAssemblePlanCountsAndSplit(t *testing.T) {
	oldest := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	feed := feedCounts{total: 10, candidates: 4, oldest: &oldest}
	notif := notifCounts{total: 8, candidates: 5, unread: 3, read: 2, oldest: &oldest}

	plan := assemblePlan("7 days", feed, notif, 0)

	if !plan.DryRun {
		t.Fatal("plan must be dry-run")
	}
	if plan.Window != "7 days" {
		t.Fatalf("window = %q, want 7 days", plan.Window)
	}
	if plan.WouldDeleteTotal != 9 {
		t.Fatalf("would_delete_total = %d, want 9", plan.WouldDeleteTotal)
	}
	if len(plan.Tables) != 2 {
		t.Fatalf("tables = %d, want 2", len(plan.Tables))
	}
	ef, nt := plan.Tables[0], plan.Tables[1]
	if ef.Table != "event_feed" || ef.Candidates != 4 || ef.Total != 10 {
		t.Fatalf("event_feed plan wrong: %+v", ef)
	}
	if ef.Unread != nil || ef.Read != nil {
		t.Fatal("event_feed must not carry an unread/read split")
	}
	if nt.Table != "notifications" || nt.Candidates != 5 {
		t.Fatalf("notifications plan wrong: %+v", nt)
	}
	if nt.Unread == nil || nt.Read == nil || *nt.Unread != 3 || *nt.Read != 2 {
		t.Fatalf("notifications unread/read split wrong: %+v", nt)
	}
	if *nt.Unread+*nt.Read != nt.Candidates {
		t.Fatalf("unread+read (%d) must equal candidates (%d)", *nt.Unread+*nt.Read, nt.Candidates)
	}
}

// TestAssemblePlanGuards checks the two reference guards and their measured
// counts are reported.
func TestAssemblePlanGuards(t *testing.T) {
	feed := feedCounts{total: 3, candidates: 3}
	plan := assemblePlan("7 days", feed, notifCounts{}, 0)

	guards := map[string]Guard{}
	for _, g := range plan.Guards {
		guards[g.Name] = g
	}
	outbox, ok := guards["outbox_events_retained"]
	if !ok || outbox.Count != 3 {
		t.Fatalf("outbox guard wrong: %+v", outbox)
	}
	dep, ok := guards["notifications_no_dependents"]
	if !ok || dep.Count != 0 {
		t.Fatalf("notifications dependents guard must report 0: %+v", dep)
	}
}

// TestProtectedTablesCoverImmutableSet asserts the static protected list covers
// every immutable/WORM table from internal/database/migrations/*.sql, so a
// reviewer sees audit, snapshots, run reports, artifacts, approvals and the
// outbox ledger are all out of scope.
func TestProtectedTablesCoverImmutableSet(t *testing.T) {
	want := []string{
		"organization_audit", "audit_records", "context_contents", "context_versions",
		"context_snapshots", "snapshot_entries", "run_reports", "artifact_contents",
		"artifacts", "task_runs", "tool_invocations", "approvals", "artifact_reviews",
		"task_reviews", "artifact_verifications", "maintenance_records", "outbox_events",
	}
	have := map[string]ProtectedTable{}
	for _, p := range protectedTables {
		if p.Trigger == "" || p.Reason == "" {
			t.Fatalf("protected %q missing trigger/reason", p.Table)
		}
		have[p.Table] = p
	}
	if len(have) != len(protectedTables) {
		t.Fatal("protected list has duplicate tables")
	}
	for _, tbl := range want {
		if _, ok := have[tbl]; !ok {
			t.Fatalf("protected list missing immutable table %q", tbl)
		}
	}
	if len(protectedTables) != len(want) {
		t.Fatalf("protected list has %d tables, want %d", len(protectedTables), len(want))
	}
}

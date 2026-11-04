package recovery

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// retentionWindow is governance's event read-back horizon (docs/governance.md:54):
// events stay readable for 7 days, so rows in the event_feed and notifications
// projections older than this window are past the read window and physically
// reapable. This command only reports; it never deletes.
const retentionWindow = "7 days"

// ProtectedTable names a table that is intentionally never reaped. Each is made
// WORM at the database layer by an immutable trigger (and grants.sql withholds
// DELETE from the runtime roles), so it holds retained audit/evidence that
// governance.md:54 forbids cleaning independently.
type ProtectedTable struct {
	Table   string `json:"table"`
	Trigger string `json:"trigger"`
	Reason  string `json:"reason"`
}

// protectedTables mirrors the immutable triggers declared in
// internal/database/migrations/*.sql. The retention plan lists these so a
// reviewer can confirm at a glance that audit, snapshots, run reports,
// artifacts, approvals and the outbox intent ledger are all out of scope.
var protectedTables = []ProtectedTable{
	{Table: "organization_audit", Trigger: "immutable_organization_audit", Reason: "organization audit trail"},
	{Table: "audit_records", Trigger: "immutable_audit", Reason: "180-day audit metadata (WORM)"},
	{Table: "context_contents", Trigger: "immutable_content", Reason: "immutable context content"},
	{Table: "context_versions", Trigger: "immutable_version", Reason: "immutable context version"},
	{Table: "context_snapshots", Trigger: "immutable_snapshot", Reason: "retained execution snapshot"},
	{Table: "snapshot_entries", Trigger: "immutable_snapshot_entry", Reason: "retained snapshot entry"},
	{Table: "run_reports", Trigger: "immutable_run_report", Reason: "30-day run report (WORM)"},
	{Table: "artifact_contents", Trigger: "immutable_artifact_content", Reason: "immutable artifact content"},
	{Table: "artifacts", Trigger: "immutable_artifact_identity", Reason: "immutable artifact identity"},
	{Table: "task_runs", Trigger: "immutable_run_identity", Reason: "immutable run identity"},
	{Table: "tool_invocations", Trigger: "immutable_invocation_binding", Reason: "immutable tool invocation binding"},
	{Table: "approvals", Trigger: "immutable_approval", Reason: "immutable approval record"},
	{Table: "artifact_reviews", Trigger: "immutable_artifact_review", Reason: "immutable artifact review"},
	{Table: "task_reviews", Trigger: "immutable_task_review", Reason: "immutable task review"},
	{Table: "artifact_verifications", Trigger: "immutable_artifact_verification", Reason: "immutable artifact verification"},
	{Table: "maintenance_records", Trigger: "immutable_maintenance_record", Reason: "immutable maintenance record"},
	{Table: "outbox_events", Trigger: "immutable_outbox_intent", Reason: "event intent ledger (replay source)"},
}

// TablePlan reports, for one reapable projection table, how many rows exist and
// how many sit past the retention window. Unread/Read split the candidates for
// notifications only (nil for event_feed) so an operator can see honestly that
// reaping would drop never-read notifications.
type TablePlan struct {
	Table      string     `json:"table"`
	AgeColumn  string     `json:"age_column"`
	Total      int64      `json:"total"`
	Candidates int64      `json:"candidates"`
	Oldest     *time.Time `json:"oldest,omitempty"`
	Unread     *int64     `json:"candidates_unread,omitempty"`
	Read       *int64     `json:"candidates_read,omitempty"`
}

// Guard is a reference-safety assertion proving the plan would not strand or
// orphan retained evidence. Count carries the measured value behind the claim.
type Guard struct {
	Name   string `json:"name"`
	Count  int64  `json:"count"`
	Detail string `json:"detail"`
}

// RetentionPlan is the read-only output of `accp-ops retention-plan`. DryRun is
// always true: this command issues no DELETE and changes no grants.
type RetentionPlan struct {
	DryRun           bool             `json:"dry_run"`
	Window           string           `json:"window"`
	GeneratedAt      time.Time        `json:"generated_at"`
	WouldDeleteTotal int64            `json:"would_delete_total"`
	Tables           []TablePlan      `json:"tables"`
	Guards           []Guard          `json:"guards"`
	Protected        []ProtectedTable `json:"protected"`
}

// feedCounts and notifCounts are the raw measurements for each projection table.
type feedCounts struct {
	total, candidates int64
	oldest            *time.Time
}

type notifCounts struct {
	total, candidates, unread, read int64
	oldest                          *time.Time
}

// PlanRetention measures reap candidates in the two projection tables and
// returns the dry-run plan. It only issues SELECTs, so a read-only role can run
// it. The apply path is deliberately absent (see .handoff/f9-f10-plan.md D1).
func PlanRetention(ctx context.Context, url string) (*RetentionPlan, error) {
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		return nil, errors.New("database unavailable")
	}
	defer db.Close(ctx)
	return planRetention(ctx, db, "accp,public")
}

// planRetention runs the read-only measurements against db using searchPath.
// The explicit search path lets tests target an isolated schema.
func planRetention(ctx context.Context, db *pgx.Conn, searchPath string) (*RetentionPlan, error) {
	if _, err := db.Exec(ctx, `SET search_path=`+searchPath); err != nil {
		return nil, err
	}
	var feed feedCounts
	if err := db.QueryRow(ctx, `SELECT count(*),
		count(*) FILTER (WHERE recorded_at < now()-interval '`+retentionWindow+`'),
		min(recorded_at)
		FROM event_feed`).Scan(&feed.total, &feed.candidates, &feed.oldest); err != nil {
		return nil, err
	}
	var notif notifCounts
	if err := db.QueryRow(ctx, `SELECT count(*),
		count(*) FILTER (WHERE occurred_at < now()-interval '`+retentionWindow+`'),
		count(*) FILTER (WHERE occurred_at < now()-interval '`+retentionWindow+`' AND read_at IS NULL),
		count(*) FILTER (WHERE occurred_at < now()-interval '`+retentionWindow+`' AND read_at IS NOT NULL),
		min(occurred_at)
		FROM notifications`).Scan(&notif.total, &notif.candidates, &notif.unread, &notif.read, &notif.oldest); err != nil {
		return nil, err
	}
	// Count foreign keys that reference notifications; zero proves reaping a
	// notification cannot orphan a child row (memberships is the referenced
	// parent and is never touched).
	var notifDependents int64
	if err := db.QueryRow(ctx, `SELECT count(*) FROM pg_constraint
		WHERE contype='f' AND confrelid='notifications'::regclass`).Scan(&notifDependents); err != nil {
		return nil, err
	}
	return assemblePlan(retentionWindow, feed, notif, notifDependents), nil
}

// assemblePlan builds the plan from measured counts. It is pure so the summing,
// unread/read split and guard wording stay unit-testable without a database.
func assemblePlan(window string, feed feedCounts, notif notifCounts, notifDependents int64) *RetentionPlan {
	unread, read := notif.unread, notif.read
	tables := []TablePlan{
		{
			Table:      "event_feed",
			AgeColumn:  "recorded_at",
			Total:      feed.total,
			Candidates: feed.candidates,
			Oldest:     feed.oldest,
		},
		{
			Table:      "notifications",
			AgeColumn:  "occurred_at",
			Total:      notif.total,
			Candidates: notif.candidates,
			Oldest:     notif.oldest,
			Unread:     &unread,
			Read:       &read,
		},
	}
	guards := []Guard{
		{
			Name:   "outbox_events_retained",
			Count:  feed.candidates,
			Detail: "event_feed.event_id references the protected outbox_events ledger; reaping these feed rows deletes 0 outbox rows, so replay can rebuild the feed.",
		},
		{
			Name:   "notifications_no_dependents",
			Count:  notifDependents,
			Detail: "foreign keys referencing notifications (must be 0): no child row is orphaned by reaping a notification.",
		},
	}
	return &RetentionPlan{
		DryRun:           true,
		Window:           window,
		GeneratedAt:      time.Now().UTC(),
		WouldDeleteTotal: feed.candidates + notif.candidates,
		Tables:           tables,
		Guards:           guards,
		Protected:        protectedTables,
	}
}

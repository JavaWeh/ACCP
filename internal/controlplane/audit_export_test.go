package controlplane

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A scanned record whose details jsonb carries both a whitelisted key and an
// unexpected one, standing in for a future field that must never reach a
// download.
func sampleRecord() auditRecord {
	return auditRecord{
		id:       "audit_1",
		org:      "org_a",
		project:  "project_demo",
		actor:    "user_a",
		action:   "POST /api/v1/x",
		resource: "task_1",
		trace:    "trace_1",
		kind:     "HUMAN",
		result:   "SUCCEEDED",
		stamp:    time.Unix(0, 0).UTC(),
		details:  []byte(`{"approval_id":"approval_1","secret_token":"LEAK","http_status":403}`),
	}
}

func TestRedactedAuditKeepsWhitelistDropsEverythingElse(t *testing.T) {
	row, err := redactedAudit(sampleRecord())
	if err != nil {
		t.Fatal(err)
	}
	if row["approval_id"] != "approval_1" {
		t.Fatalf("whitelisted approval_id not copied: %v", row["approval_id"])
	}
	if _, ok := row["secret_token"]; ok {
		t.Fatal("non-whitelisted detail leaked into export row")
	}
	if _, ok := row["details"]; ok {
		t.Fatal("raw details object was dumped")
	}
	if row["accountable_user_id"] != "user_a" || row["actor_user_id"] != "user_a" {
		t.Fatalf("actor fields wrong: %v / %v", row["accountable_user_id"], row["actor_user_id"])
	}
}

func TestAuditSerializersNeverLeakRawDetails(t *testing.T) {
	records := []auditRecord{sampleRecord()}
	jsonl, err := auditJSONL(records)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(jsonl), "LEAK") || strings.Contains(string(jsonl), "secret_token") {
		t.Fatalf("jsonl leaked raw details: %s", jsonl)
	}
	if !strings.Contains(string(jsonl), "approval_1") {
		t.Fatal("jsonl dropped whitelisted detail")
	}
	csv, err := auditCSV(records)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(csv), "id,occurred_at") {
		t.Fatalf("csv missing fixed header: %s", csv)
	}
	if strings.Contains(string(csv), "LEAK") || strings.Contains(string(csv), "secret_token") {
		t.Fatalf("csv leaked raw details: %s", csv)
	}
}

func TestCSVCellRendersArtifactLists(t *testing.T) {
	if got := csvCell([]any{"artifact_a", "artifact_b"}); got != "artifact_a artifact_b" {
		t.Fatalf("artifact list rendering: %q", got)
	}
	if got := csvCell(nil); got != "" {
		t.Fatalf("nil cell: %q", got)
	}
	if got := csvCell(float64(403)); got != "403" {
		t.Fatalf("number cell: %q", got)
	}
}

func TestParseAuditTimeAcceptsRFC3339AndBareDates(t *testing.T) {
	if _, err := parseAuditTime("2026-10-29T12:00:00Z", false); err != nil {
		t.Fatalf("rfc3339: %v", err)
	}
	start, err := parseAuditTime("2026-10-29", false)
	if err != nil || start.Hour() != 0 || start.Minute() != 0 {
		t.Fatalf("bare start-of-day: %v %v", start, err)
	}
	end, err := parseAuditTime("2026-10-29", true)
	if err != nil || end.Hour() != 23 || end.Day() != 29 {
		t.Fatalf("bare end-of-day: %v %v", end, err)
	}
	if _, err := parseAuditTime("not-a-date", false); err == nil {
		t.Fatal("expected an error for a malformed date")
	}
}

func TestAuditFilterBindsSequentialPlaceholders(t *testing.T) {
	f := &auditFilter{}
	f.bind("a.project_id=$%d", "p")
	f.bind("a.actor_user_id=$%d", "u")
	if f.where[0] != "a.project_id=$1" || f.where[1] != "a.actor_user_id=$2" {
		t.Fatalf("placeholder numbering: %v", f.where)
	}
	if len(f.args) != 2 {
		t.Fatalf("args length: %d", len(f.args))
	}
}

func TestExecutionFiltersBuildEveryDimension(t *testing.T) {
	r := httptest.NewRequest("GET", "/x?actor=u&task=t&action=a&from=2026-10-29&to=2026-10-30", nil)
	f := &auditFilter{}
	if err := executionFilters(f, r); err != nil {
		t.Fatal(err)
	}
	if len(f.where) != 5 {
		t.Fatalf("expected 5 conditions, got %d: %v", len(f.where), f.where)
	}
	// A malformed date surfaces a 400 rather than building a bad clause.
	bad := httptest.NewRequest("GET", "/x?from=nonsense", nil)
	if err := executionFilters(&auditFilter{}, bad); err == nil {
		t.Fatal("expected a filter error for a malformed from date")
	}
}

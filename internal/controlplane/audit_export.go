package controlplane

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// auditExportLimit caps a single export so one request cannot stream the whole
// journal and exhaust a node. Past the ceiling the caller must narrow filters
// (PRD/NFR §10). The sentinel +1 row distinguishes "exactly at limit" from
// "over".
const auditExportLimit = 50000

// auditDetailWhitelist is the exact set of details keys the recorder ever
// writes (events.go / governance_worker.go) plus the denial markers
// (denial_audit.go). Exports copy only these keys; the raw details jsonb is
// NEVER dumped, so a future detail field cannot silently leak into a download.
var auditDetailWhitelist = []string{"approval_id", "artifact_ids", "delegated_by_user_id", "execution_session_id", "reviewed_by_user_id", "error_code", "http_status"}

// auditExportColumns is the fixed CSV column order. It mirrors the recordAudit
// field whitelist and the AuditRecord contract. It contains no tokens, secrets,
// or private context bodies (governance.md §52).
var auditExportColumns = []string{
	"id", "occurred_at", "organization_id", "project_id",
	"actor_kind", "actor_user_id", "actor_session_id", "agent_id", "service_id",
	"accountable_user_id", "owner_user_id",
	"action", "resource_id", "result",
	"task_id", "task_run_id", "context_snapshot_id", "trace_id", "reason",
	"approval_id", "artifact_ids", "delegated_by_user_id", "execution_session_id", "reviewed_by_user_id", "error_code", "http_status",
}

// redactedAudit builds one export row from a scanned record. It copies the
// fixed top-level fields and only the whitelisted detail keys; everything else
// in the details jsonb is discarded. It is pure (no DB, no request) so the
// redaction guarantee is unit-testable.
func redactedAudit(a auditRecord) (Object, error) {
	var raw Object
	if len(a.details) > 0 {
		if err := json.Unmarshal(a.details, &raw); err != nil {
			return nil, err
		}
	}
	row := Object{
		"id":                  a.id,
		"occurred_at":         a.stamp.UTC().Format(time.RFC3339Nano),
		"organization_id":     a.org,
		"project_id":          a.project,
		"actor_kind":          a.kind,
		"actor_user_id":       a.actor,
		"actor_session_id":    a.session,
		"agent_id":            a.agent,
		"accountable_user_id": a.actor,
		"owner_user_id":       a.owner,
		"action":              a.action,
		"resource_id":         a.resource,
		"result":              a.result,
		"task_id":             a.task,
		"task_run_id":         a.run,
		"context_snapshot_id": a.snapshot,
		"trace_id":            a.trace,
		"reason":              a.reason,
	}
	if a.kind == "SERVICE" {
		row["service_id"] = "accp_worker"
	}
	for _, k := range auditDetailWhitelist {
		if v, ok := raw[k]; ok {
			row[k] = v
		}
	}
	return row, nil
}

func auditJSONL(records []auditRecord) ([]byte, error) {
	var b bytes.Buffer
	for _, a := range records {
		row, err := redactedAudit(a)
		if err != nil {
			return nil, err
		}
		line, err := json.Marshal(row)
		if err != nil {
			return nil, err
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	return b.Bytes(), nil
}

func auditCSV(records []auditRecord) ([]byte, error) {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	if err := w.Write(auditExportColumns); err != nil {
		return nil, err
	}
	for _, a := range records {
		row, err := redactedAudit(a)
		if err != nil {
			return nil, err
		}
		cells := make([]string, len(auditExportColumns))
		for i, col := range auditExportColumns {
			cells[i] = csvCell(row[col])
		}
		if err := w.Write(cells); err != nil {
			return nil, err
		}
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

func csvCell(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			parts[i] = fmt.Sprint(e)
		}
		return strings.Join(parts, " ")
	case []string:
		return strings.Join(t, " ")
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return fmt.Sprint(t)
	}
}

func serializeAudit(format string, records []auditRecord) ([]byte, string, error) {
	if format == "csv" {
		body, err := auditCSV(records)
		return body, "text/csv; charset=utf-8", err
	}
	body, err := auditJSONL(records)
	return body, "application/x-ndjson", err
}

// auditFormat resolves the requested export format, defaulting to JSONL.
func auditFormat(r *http.Request) (string, error) {
	switch r.URL.Query().Get("format") {
	case "", "jsonl":
		return "jsonl", nil
	case "csv":
		return "csv", nil
	default:
		return "", fail(400, "INVALID_FORMAT", "Supported export formats are jsonl and csv.")
	}
}

// gatherAuditExport runs the primed filter, capped at the export ceiling.
func gatherAuditExport(q *request, f *auditFilter) ([]auditRecord, error) {
	limitArg := len(f.args) + 1
	f.args = append(f.args, auditExportLimit+1)
	query := "SELECT " + auditColumns + auditFrom + " WHERE " + strings.Join(f.where, " AND ") + fmt.Sprintf(" ORDER BY a.id LIMIT $%d", limitArg)
	rows, err := q.tx.Query(q.http.Context(), query, f.args...)
	if err != nil {
		return nil, err
	}
	records, err := scanAudit(rows)
	if err != nil {
		return nil, err
	}
	if len(records) > auditExportLimit {
		return nil, fail(413, "EXPORT_TOO_LARGE", "Narrow the filters; the export exceeds the per-request row limit.")
	}
	return records, nil
}

func auditDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func auditFilename(scope, format string) string {
	safe := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, scope)
	return fmt.Sprintf("audit-%s-%s.%s", safe, time.Now().UTC().Format("20060102T150405Z"), format)
}

// auditFilterSummary records which filters produced an export, for the export's
// own audit entry. It carries no row contents.
func auditFilterSummary(r *http.Request) Object {
	q := r.URL.Query()
	s := Object{}
	for _, k := range []string{"project", "actor", "task", "action", "from", "to"} {
		if v := q.Get(k); v != "" {
			s[k] = v
		}
	}
	return s
}

func auditFilterText(r *http.Request) string {
	q := r.URL.Query()
	parts := []string{}
	for _, k := range []string{"project", "actor", "task", "action", "from", "to"} {
		if v := q.Get(k); v != "" {
			parts = append(parts, k+"="+v)
		}
	}
	if len(parts) == 0 {
		return "filters=none"
	}
	return strings.Join(parts, " ")
}

// exportProjectAudit streams a redacted JSONL/CSV export of one project's
// execution audit (project ADMIN only; gated by the route's role:"ADMIN"). The
// GET runs inside the project transaction that execute() commits, so the export
// audit row written here lands atomically with the download.
func exportProjectAudit(q *request) (reply, error) {
	format, err := auditFormat(q.http)
	if err != nil {
		return reply{}, err
	}
	f := &auditFilter{}
	f.bind("a.project_id=$%d", q.project)
	f.bind("a.organization_id=$%d", q.org)
	if err = executionFilters(f, q.http); err != nil {
		return reply{}, err
	}
	records, err := gatherAuditExport(q, f)
	if err != nil {
		return reply{}, err
	}
	body, contentType, err := serializeAudit(format, records)
	if err != nil {
		return reply{}, err
	}
	digest := auditDigest(body)
	summary := auditFilterSummary(q.http)
	summary["project"] = q.project
	details, _ := json.Marshal(Object{"format": format, "row_count": len(records), "content_sha256": digest, "filters": summary})
	if _, err = q.tx.Exec(q.http.Context(), `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,action,resource_id,resource_version,trace_id,actor_kind,result,details) VALUES($1,$2,$3,$4,$5,$6,0,$7,'HUMAN','SUCCEEDED',$8)`, newID("audit"), q.project, q.org, q.user, q.http.Pattern, digest, q.trace, details); err != nil {
		return reply{}, err
	}
	return reply{status: 200, contentType: contentType, download: auditFilename(q.project, format), raw: body}, nil
}

// organizationExecutionAudit lists the organization's execution audit across
// every project (organization ADMIN only), with an optional project scope. It
// is the data source behind the O-W16 "organization audit" view and reads the
// same audit_records journal as the project page, so the two lists are
// isomorphic. (It is distinct from organizationAudit, which keeps serving the
// org-management journal in organization_audit.)
func organizationExecutionAudit(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	f := &auditFilter{}
	f.bind("a.organization_id=$%d", q.org)
	f.bind("a.id>$%d", cursor)
	if project := q.http.URL.Query().Get("project"); project != "" {
		f.bind("a.project_id=$%d", project)
	}
	if err = executionFilters(f, q.http); err != nil {
		return reply{}, err
	}
	return listAuditRecords(q, f, limit)
}

// exportOrganizationAudit streams the cross-project redacted export (org ADMIN
// only). Organization GETs are not committed by executeOrganization, so the
// export's audit row is written and committed here before the file is returned.
func exportOrganizationAudit(q *request) (reply, error) {
	format, err := auditFormat(q.http)
	if err != nil {
		return reply{}, err
	}
	f := &auditFilter{}
	f.bind("a.organization_id=$%d", q.org)
	scope := "organization"
	if project := q.http.URL.Query().Get("project"); project != "" {
		f.bind("a.project_id=$%d", project)
		scope = project
	}
	if err = executionFilters(f, q.http); err != nil {
		return reply{}, err
	}
	records, err := gatherAuditExport(q, f)
	if err != nil {
		return reply{}, err
	}
	body, contentType, err := serializeAudit(format, records)
	if err != nil {
		return reply{}, err
	}
	digest := auditDigest(body)
	// organization_audit has no details column, so the filter summary, row
	// count, and content hash are packed into reason; resource_id is the hash.
	reason := fmt.Sprintf("format=%s rows=%d %s", format, len(records), auditFilterText(q.http))
	if _, err = q.tx.Exec(q.http.Context(), `INSERT INTO organization_audit(id,organization_id,actor_id,action,resource_id,result,reason,trace_id) VALUES($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7)`, newID("audit"), q.org, q.user, q.http.Pattern, digest, reason, q.trace); err != nil {
		return reply{}, err
	}
	if err = q.tx.Commit(q.http.Context()); err != nil {
		return reply{}, err
	}
	return reply{status: 200, contentType: contentType, download: auditFilename(scope, format), raw: body}, nil
}

package controlplane

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// auditColumns and auditFrom are shared by every reader of the execution audit
// journal (the project list, the organization cross-project list, and both
// redacted exports) so the scanned shape stays identical. project_id and
// organization_id are selected per row because the organization readers are
// cross-project and cannot assume a single scope.
const auditColumns = `a.id,a.organization_id,a.project_id,a.actor_user_id,a.action,a.resource_id,a.trace_id,a.recorded_at,a.actor_kind,coalesce(a.actor_session_id,''),coalesce(s.agent_id,''),coalesce(a.task_run_id,''),coalesce(a.owner_user_id,''),coalesce(a.context_snapshot_id,''),coalesce(r.task_id,''),a.result,a.details,coalesce(a.reason,'')`

const auditFrom = ` FROM audit_records a LEFT JOIN agent_sessions s ON s.id=a.actor_session_id LEFT JOIN task_runs r ON r.id=a.task_run_id`

type auditRecord struct {
	id, org, project, actor, action, resource, trace, kind string
	session, agent, run, owner, snapshot, task             string
	result, reason                                         string
	stamp                                                  time.Time
	details                                                []byte
}

// auditFilter accumulates parameterized WHERE conditions. Every value is bound
// as a query parameter and never interpolated, so user-supplied filters cannot
// inject SQL.
type auditFilter struct {
	where []string
	args  []any
}

func (f *auditFilter) bind(cond string, val any) {
	f.args = append(f.args, val)
	f.where = append(f.where, fmt.Sprintf(cond, len(f.args)))
}

// parseAuditTime accepts RFC3339 timestamps and bare calendar dates
// (YYYY-MM-DD, the value a native date input produces). For an inclusive upper
// bound a bare date resolves to the end of that UTC day so "to=2026-10-29"
// still matches every record recorded on the 29th.
func parseAuditTime(value string, end bool) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t, nil
	}
	if d, err := time.Parse("2006-01-02", value); err == nil {
		if end {
			return d.Add(24*time.Hour - time.Nanosecond), nil
		}
		return d, nil
	}
	return time.Time{}, fail(400, "INVALID_FILTER", "Dates must be RFC3339 timestamps or YYYY-MM-DD.")
}

// executionFilters reads the shared actor/task/action/from/to query parameters
// and appends them to f using the execution-audit column aliases (a =
// audit_records, r = task_runs). Absent parameters leave the query unchanged,
// which keeps the unfiltered reads backward compatible.
func executionFilters(f *auditFilter, r *http.Request) error {
	q := r.URL.Query()
	if v := q.Get("actor"); v != "" {
		f.bind("a.actor_user_id=$%d", v)
	}
	if v := q.Get("task"); v != "" {
		f.bind("r.task_id=$%d", v)
	}
	if v := q.Get("action"); v != "" {
		f.bind("a.action=$%d", v)
	}
	if v := q.Get("from"); v != "" {
		t, err := parseAuditTime(v, false)
		if err != nil {
			return err
		}
		f.bind("a.recorded_at>=$%d", t)
	}
	if v := q.Get("to"); v != "" {
		t, err := parseAuditTime(v, true)
		if err != nil {
			return err
		}
		f.bind("a.recorded_at<=$%d", t)
	}
	return nil
}

func scanAudit(rows pgx.Rows) ([]auditRecord, error) {
	defer rows.Close()
	out := []auditRecord{}
	for rows.Next() {
		var a auditRecord
		if err := rows.Scan(&a.id, &a.org, &a.project, &a.actor, &a.action, &a.resource, &a.trace, &a.stamp, &a.kind, &a.session, &a.agent, &a.run, &a.owner, &a.snapshot, &a.task, &a.result, &a.details, &a.reason); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func auditActor(a auditRecord) Object {
	switch a.kind {
	case "AGENT":
		return Object{"kind": a.kind, "session_id": a.session, "agent_id": a.agent}
	case "SERVICE":
		return Object{"kind": a.kind, "service_id": "accp_worker"}
	default:
		return Object{"kind": a.kind, "user_id": a.actor}
	}
}

// auditDoc renders the full in-app list shape (unchanged from the original
// executionAudit projection, including the whitelisted details object the
// recorder already wrote). Exports use the stricter redactedAudit instead.
func auditDoc(a auditRecord) (Object, error) {
	var extra Object
	if err := json.Unmarshal(a.details, &extra); err != nil {
		return nil, err
	}
	doc := Object{"id": a.id, "organization_id": a.org, "project_id": a.project, "actor": auditActor(a), "accountable_user_id": a.actor, "action": a.action, "resource_id": a.resource, "result": a.result, "trace_id": a.trace, "occurred_at": a.stamp.UTC().Format(time.RFC3339Nano), "details": extra, "reason": a.reason}
	for k, v := range map[string]string{"task_run_id": a.run, "owner_user_id": a.owner, "context_snapshot_id": a.snapshot, "task_id": a.task} {
		if v != "" {
			doc[k] = v
		}
	}
	return doc, nil
}

// listAuditRecords runs the assembled filter as a cursor page. Callers prime f
// with the scope (project or organization) and any filters; the limit sentinel
// row is appended here so pagination stays consistent across readers.
func listAuditRecords(q *request, f *auditFilter, limit int) (reply, error) {
	limitArg := len(f.args) + 1
	f.args = append(f.args, limit+1)
	query := "SELECT " + auditColumns + auditFrom + " WHERE " + strings.Join(f.where, " AND ") + fmt.Sprintf(" ORDER BY a.id LIMIT $%d", limitArg)
	rows, err := q.tx.Query(q.http.Context(), query, f.args...)
	if err != nil {
		return reply{}, err
	}
	records, err := scanAudit(rows)
	if err != nil {
		return reply{}, err
	}
	items := []Object{}
	for _, rec := range records {
		doc, err := auditDoc(rec)
		if err != nil {
			return reply{}, err
		}
		items = append(items, doc)
	}
	return page(q.http, items, limit), nil
}

func executionAudit(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	f := &auditFilter{}
	f.bind("a.project_id=$%d", q.project)
	f.bind("a.organization_id=$%d", q.org)
	f.bind("a.id>$%d", cursor)
	if err = executionFilters(f, q.http); err != nil {
		return reply{}, err
	}
	return listAuditRecords(q, f, limit)
}

package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/jackc/pgx/v5"
)

func validateInvocation(q *request, doc Object, approved bool) error {
	binding := doc["binding"].(map[string]any)
	provenance := doc["provenance"].(map[string]any)
	expiry, e := time.Parse(time.RFC3339Nano, textValue(binding, "expires_at"))
	if e != nil || !time.Now().Before(expiry) {
		return fail(409, "APPROVAL_EXPIRED", "This operation binding has expired.")
	}
	p, e := session(q, textValue(provenance, "session_id"))
	if e != nil {
		return e
	}
	if !p.active() || p.Project != q.project || !slices.Contains(p.Scopes, "tools:invoke") {
		return fail(403, "DELEGATION_REVOKED", "Tool execution authority is no longer valid.")
	}
	var authorized bool
	e = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND u.active AND ('MEMBER'=ANY(m.roles) OR 'ADMIN'=ANY(m.roles))) AND EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$3 AND m.active AND u.active)`, q.project, p.Human, provenance["owner_user_id"]).Scan(&authorized)
	if e != nil {
		return e
	}
	if !authorized {
		return fail(403, "DELEGATION_REVOKED", "Human authority changed.")
	}
	run, e := readDocument(q, "task_runs", textValue(provenance, "task_run_id"))
	if e != nil {
		return e
	}
	lease, _ := time.Parse(time.RFC3339Nano, textValue(run, "lease_expires_at"))
	task, e := readDocument(q, "tasks", textValue(provenance, "task_id"))
	if e != nil {
		return e
	}
	if run["status"] != "RUNNING" || !time.Now().Before(lease) || task["status"] != "RUNNING" || run["session_id"] != p.ID {
		return fail(409, "RUN_INACTIVE", "An active Run lease is required at execution time.")
	}
	policy, e := readDocument(q, "tool_policies", textValue(binding, "tool_id"))
	if e != nil {
		return e
	}
	b, e := q.server.options.Tools.Get(textValue(policy, "backend_id"), q.project)
	if e != nil {
		return fail(403, "TOOL_UNAVAILABLE", "Tool backend is unavailable.")
	}
	if policy["enabled"] != true || strconv.FormatInt(number(policy, "version"), 10) != binding["policy_version"] || policy["resource_version"] != binding["resource_version"] || b.Version != binding["tool_schema_version"] || b.ResourceID != binding["resource_id"] || b.ReadOnly != (policy["risk"] == "READ_ONLY") {
		return fail(412, "POLICY_CHANGED", "Policy, schema or resource changed after this request.")
	}
	args := doc["parameters"].(map[string]any)
	data, _ := json.Marshal(args)
	bound, _ := json.Marshal(binding)
	if auth.Digest(string(data)) != binding["parameters_digest"] || auth.Digest(string(bound)) != doc["binding_digest"] || b.Validate(args) != nil {
		return fail(412, "BINDING_CHANGED", "The approved operation no longer matches its binding.")
	}
	if approved && policy["risk"] != "READ_ONLY" {
		approval, e := readDocument(q, "approvals", textValue(doc, "approval_id"))
		if e != nil {
			return e
		}
		if approval["status"] != "APPROVED" || approval["binding_digest"] != doc["binding_digest"] || approval["decided_by_user_id"] == p.Human {
			return fail(403, "APPROVAL_REQUIRED", "This exact operation needs an independent human decision.")
		}
		var reviewer bool
		e = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND u.active AND ('REVIEWER'=ANY(m.roles) OR 'ADMIN'=ANY(m.roles)))`, q.project, approval["decided_by_user_id"]).Scan(&reviewer)
		if e != nil {
			return e
		}
		if !reviewer {
			return fail(403, "REVIEWER_REVOKED", "Reviewer authority was revoked.")
		}
	}
	return nil
}
func invocationAudit(q *request, doc Object, action string) error {
	p := doc["provenance"].(map[string]any)
	details := Object{"invocation_id": doc["id"], "binding_digest": doc["binding_digest"], "artifact_ids": doc["binding"].(map[string]any)["artifact_ids"]}
	if id, ok := doc["approval_id"]; ok {
		details["approval_id"] = id
		approval, e := readDocument(q, "approvals", id.(string))
		if e != nil {
			return e
		}
		if reviewer, ok := approval["decided_by_user_id"]; ok {
			details["reviewed_by_user_id"] = reviewer
		}
	}
	data, _ := json.Marshal(details)
	_, e := q.tx.Exec(q.http.Context(), `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,actor_kind,actor_session_id,action,resource_id,resource_version,trace_id,task_run_id,owner_user_id,context_snapshot_id,result,details) VALUES($1,$2,$3,$4,'SERVICE',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, newID("audit"), q.project, q.org, p["delegated_by_user_id"], p["session_id"], action, doc["id"], doc["version"], q.trace, p["task_run_id"], p["owner_user_id"], p["context_snapshot_id"], doc["status"], data)
	return e
}

// ProcessTools commits intent before effects. A crashed RUNNING operation is never automatically retried.
func (s *Server) ProcessTools(ctx context.Context) error {
	rows, e := s.pool.Query(ctx, `SELECT id,project_id,organization_id FROM tool_invocations WHERE status IN ('READY','AWAITING_APPROVAL') OR (status='RUNNING' AND started_at<clock_timestamp()-interval '45 seconds') ORDER BY id LIMIT 25`)
	if e != nil {
		return e
	}
	type item struct{ id, project, org string }
	items := []item{}
	for rows.Next() {
		var i item
		if e = rows.Scan(&i.id, &i.project, &i.org); e != nil {
			rows.Close()
			return e
		}
		items = append(items, i)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, i := range items {
		if e = s.processInvocation(ctx, i.id, i.project, i.org); e != nil {
			return e
		}
	}
	return nil
}
func (s *Server) invocationTransaction(ctx context.Context, project, org string) (*request, error) {
	tx, e := s.pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	var id string
	e = tx.QueryRow(ctx, `SELECT id FROM projects WHERE id=$1 AND organization_id=$2 FOR UPDATE SKIP LOCKED`, project, org).Scan(&id)
	if e != nil {
		_ = tx.Rollback(ctx)
		return nil, e
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://worker/tools", nil)
	return &request{tx: tx, http: req, server: s, project: project, org: org, trace: newID("trace")}, nil
}
func (s *Server) processInvocation(ctx context.Context, id, project, org string) error {
	q, e := s.invocationTransaction(ctx, project, org)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	defer q.tx.Rollback(ctx)
	doc, e := readDocument(q, "tool_invocations", id)
	if e != nil {
		return e
	}
	state := doc["status"]
	if state == "RUNNING" {
		doc["status"] = "UNKNOWN"
		doc["error_code"] = "WORKER_INTERRUPTED"
		if e = saveInvocation(q, doc, nil); e != nil {
			return e
		}
		if e = invocationAudit(q, doc, "worker.tool_unknown"); e != nil {
			return e
		}
		return q.tx.Commit(ctx)
	}
	if state != "READY" && state != "AWAITING_APPROVAL" {
		return nil
	}
	if e = validateInvocation(q, doc, state == "READY"); e != nil {
		doc["status"] = "CANCELED"
		doc["error_code"] = "AUTHORITY_OR_BINDING_CHANGED"
		if e = saveInvocation(q, doc, nil); e != nil {
			return e
		}
		if a, ok := doc["approval_id"]; ok {
			approval, er := readDocument(q, "approvals", a.(string))
			if er != nil {
				return er
			}
			if approval["status"] == "PENDING" {
				approval["status"] = "EXPIRED"
				approval["version"] = number(approval, "version") + 1
				data, _ := json.Marshal(approval)
				if _, e = q.tx.Exec(ctx, `UPDATE approvals SET document=$1 WHERE id=$2`, data, a); e != nil {
					return e
				}
			}
		}
		if e = invocationAudit(q, doc, "worker.tool_canceled"); e != nil {
			return e
		}
		return q.tx.Commit(ctx)
	}
	if state == "AWAITING_APPROVAL" {
		return nil
	}
	doc["status"] = "RUNNING"
	if e = saveInvocation(q, doc, nil); e != nil {
		return e
	}
	if e = invocationAudit(q, doc, "worker.tool_started"); e != nil {
		return e
	}
	if e = q.tx.Commit(ctx); e != nil {
		return e
	}
	// Hold the project authorization lock through the bounded effect. Revocation serializes with this boundary.
	next, e := s.invocationTransaction(ctx, project, org)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	defer next.tx.Rollback(ctx)
	doc, e = readDocument(next, "tool_invocations", id)
	if e != nil {
		return e
	}
	if doc["status"] != "RUNNING" {
		return nil
	}
	if e = validateInvocation(next, doc, true); e != nil {
		doc["status"] = "CANCELED"
		doc["error_code"] = "PRE_EXECUTION_AUTHORITY_CHANGED"
	} else {
		binding := doc["binding"].(map[string]any)
		policy, e := readDocument(next, "tool_policies", textValue(binding, "tool_id"))
		if e != nil {
			return e
		}
		backend, e := s.options.Tools.Get(textValue(policy, "backend_id"), project)
		if e != nil {
			return e
		}
		operation, cancel := context.WithTimeout(ctx, 12*time.Second)
		result, callErr := s.options.Tools.Execute(operation, backend, doc["parameters"].(map[string]any), id, textValue(binding, "resource_version"))
		cancel()
		if callErr != nil {
			doc["status"] = "UNKNOWN"
			doc["error_code"] = "EXTERNAL_OUTCOME_UNKNOWN"
		} else {
			doc["status"] = "SUCCEEDED"
			doc["completed_at"] = now()
			data, _ := json.Marshal(result)
			doc["result_digest"] = auth.Digest(string(data))
			if e = saveInvocation(next, doc, result); e != nil {
				return e
			}
			if e = invocationAudit(next, doc, "worker.tool_finished"); e != nil {
				return e
			}
			return next.tx.Commit(ctx)
		}
	}
	if e = saveInvocation(next, doc, nil); e != nil {
		return e
	}
	if e = invocationAudit(next, doc, "worker.tool_finished"); e != nil {
		return e
	}
	return next.tx.Commit(ctx)
}
func reconcileInvocation(q *request) (reply, error) {
	doc, e := readDocument(q, "tool_invocations", q.http.PathValue("id"))
	if e != nil {
		return reply{}, e
	}
	if e = match(q, number(doc, "version")); e != nil {
		return reply{}, e
	}
	if doc["status"] != "UNKNOWN" {
		return reply{}, fail(409, "RECONCILIATION_NOT_REQUIRED", "Only uncertain operations can be reconciled.")
	}
	binding := doc["binding"].(map[string]any)
	policy, e := readDocument(q, "tool_policies", textValue(binding, "tool_id"))
	if e != nil {
		return reply{}, e
	}
	b, e := q.server.options.Tools.Get(textValue(policy, "backend_id"), q.project)
	if e != nil {
		return reply{}, fail(503, "TOOL_UNAVAILABLE", "The original backend is unavailable.")
	}
	if b.Version != binding["tool_schema_version"] || b.ResourceID != binding["resource_id"] {
		return reply{}, fail(409, "BACKEND_CHANGED", "Restore the original lookup configuration before reconciling.")
	}
	result, e := q.server.options.Tools.Reconcile(q.http.Context(), b, doc["parameters"].(map[string]any), textValue(doc, "id"), textValue(binding, "resource_version"))
	if e != nil {
		return reply{}, fail(409, "OUTCOME_UNKNOWN", "The external system has not confirmed an outcome; no operation was retried.")
	}
	doc["status"] = "SUCCEEDED"
	if result["state"] == "FAILED" {
		doc["status"] = "FAILED"
	}
	doc["completed_at"] = now()
	data, _ := json.Marshal(result)
	doc["result_digest"] = auth.Digest(string(data))
	if e = saveInvocation(q, doc, result); e != nil {
		return reply{}, e
	}
	e = invocationAudit(q, doc, "human.tool_reconciled")
	return entity(200, doc), e
}

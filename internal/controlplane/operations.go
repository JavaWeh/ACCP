package controlplane

import "encoding/json"

func (s *Server) operationsRoutes(routes map[string]operation) {
	for path, op := range map[string]operation{
		"GET /api/v1/projects/{id}/audit-export":   {table: "projects", role: "ADMIN", run: executionAudit},
		"GET /api/v1/projects/{id}/event-failures": {table: "projects", role: "ADMIN", run: listEventFailures},
		"GET /api/v1/projects/{id}/diagnostics":    {table: "projects", role: "ADMIN", run: projectDiagnostics},
		"GET /api/v1/projects/{id}/recovery-items": {table: "projects", role: "ADMIN", run: listRecoveryItems},
	} {
		routes[path] = op
	}
}
func listEventFailures(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT o.id,o.event->>'type',o.attempts,o.last_error_code,f.error_code,f.attempts,f.failed_at FROM outbox_events o LEFT JOIN event_failures f ON f.event_id=o.id AND f.resolved_at IS NULL WHERE o.project_id=$1 AND o.organization_id=$2 AND o.id>$3 AND (o.last_error_code IS NOT NULL OR f.event_id IS NOT NULL) ORDER BY o.id LIMIT $4`, q.project, q.org, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id string
		var kind, publish, consume *string
		var attempts int64
		var consumerAttempts *int64
		var at any
		if err = rows.Scan(&id, &kind, &attempts, &publish, &consume, &consumerAttempts, &at); err != nil {
			return reply{}, err
		}
		items = append(items, Object{"id": id, "event_type": kind, "publish_attempts": attempts, "publish_error": publish, "consume_error": consume, "consume_attempts": consumerAttempts, "failed_at": at})
	}
	return page(q.http, items, limit), rows.Err()
}
func listRecoveryItems(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT to_jsonb(r) FROM recovery_items r WHERE project_id=$1 AND id>$2 ORDER BY id LIMIT $3`, q.project, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data); err != nil {
			return reply{}, err
		}
		var doc Object
		if err = json.Unmarshal(data, &doc); err != nil {
			return reply{}, err
		}
		items = append(items, doc)
	}
	return page(q.http, items, limit), rows.Err()
}
func projectDiagnostics(q *request) (reply, error) {
	var paused bool
	var outbox, failed, unknown, approvals, expired, recovery int64
	err := q.tx.QueryRow(q.http.Context(), `SELECT (SELECT maintenance FROM runtime_state WHERE id='default'),(SELECT count(*) FROM outbox_events WHERE project_id=$1 AND delivered_at IS NULL),(SELECT count(*) FROM event_failures f JOIN outbox_events o ON o.id=f.event_id WHERE o.project_id=$1 AND f.resolved_at IS NULL),(SELECT count(*) FROM tool_invocations WHERE project_id=$1 AND status='UNKNOWN'),(SELECT count(*) FROM approvals WHERE project_id=$1 AND document->>'status'='PENDING'),(SELECT count(*) FROM task_runs WHERE project_id=$1 AND status='RUNNING' AND lease_expires_at<clock_timestamp()),(SELECT count(*) FROM recovery_items WHERE project_id=$1 AND resolved_at IS NULL)`, q.project).Scan(&paused, &outbox, &failed, &unknown, &approvals, &expired, &recovery)
	return reply{status: 200, body: Object{"project_id": q.project, "maintenance": paused, "outbox_pending": outbox, "event_failures": failed, "unknown_operations": unknown, "pending_approvals": approvals, "expired_leases": expired, "recovery_pending": recovery, "checked_at": now()}}, err
}

package controlplane

func projectSummary(q *request) (reply, error) {
	var total, running, review, approvals int64
	err := q.tx.QueryRow(q.http.Context(), `SELECT count(*),count(*) FILTER (WHERE status='RUNNING'),count(*) FILTER (WHERE status='IN_REVIEW') FROM tasks WHERE project_id=$1 AND organization_id=$2 AND NOT archived`, q.project, q.org).Scan(&total, &running, &review)
	if err != nil {
		return reply{}, err
	}
	if hasRole(q.roles, "REVIEWER") || hasRole(q.roles, "ADMIN") {
		err = q.tx.QueryRow(q.http.Context(), `SELECT count(*) FROM approvals WHERE project_id=$1 AND organization_id=$2 AND document->>'status'='PENDING'`, q.project, q.org).Scan(&approvals)
	}
	return reply{status: 200, body: Object{"tasks": total, "running": running, "review": review, "approvals": approvals}}, err
}

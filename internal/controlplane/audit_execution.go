package controlplane

import "time"

func executionAudit(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT a.id,a.actor_user_id,a.action,a.resource_id,a.trace_id,a.recorded_at,a.actor_kind,coalesce(a.actor_session_id,''),coalesce(s.agent_id,''),coalesce(a.task_run_id,''),coalesce(a.owner_user_id,''),coalesce(a.context_snapshot_id,''),coalesce(r.task_id,'') FROM audit_records a LEFT JOIN agent_sessions s ON s.id=a.actor_session_id LEFT JOIN task_runs r ON r.id=a.task_run_id WHERE a.project_id=$1 AND a.organization_id=$2 AND a.id>$3 ORDER BY a.id LIMIT $4`, q.project, q.org, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, user, action, resource, trace, kind, session, agent, run, owner, snapshot, task string
		var stamp time.Time
		if err = rows.Scan(&id, &user, &action, &resource, &trace, &stamp, &kind, &session, &agent, &run, &owner, &snapshot, &task); err != nil {
			return reply{}, err
		}
		actor := Object{"kind": kind, "user_id": user}
		if kind == "AGENT" {
			actor = Object{"kind": kind, "session_id": session, "agent_id": agent}
		}
		if kind == "SERVICE" {
			actor = Object{"kind": kind, "service_id": "accp_worker"}
		}
		doc := Object{"id": id, "organization_id": q.org, "project_id": q.project, "actor": actor, "accountable_user_id": user, "action": action, "resource_id": resource, "result": "SUCCEEDED", "trace_id": trace, "occurred_at": stamp.UTC().Format(time.RFC3339Nano)}
		for k, v := range map[string]string{"task_run_id": run, "owner_user_id": owner, "context_snapshot_id": snapshot, "task_id": task} {
			if v != "" {
				doc[k] = v
			}
		}
		items = append(items, doc)
	}
	return page(q.http, items, limit), rows.Err()
}

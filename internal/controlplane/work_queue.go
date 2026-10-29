package controlplane

import (
	"encoding/json"
)

// workQueueLimit bounds each group so a single caller cannot pull an unbounded
// backlog. The queue is a bounded set of actionable items, so v1 does not page
// (see .handoff/f1f2-impl.md decision D-1).
const workQueueLimit = 200

// workGroup maps a task document status to its my-work group, returning an
// empty string when the status does not belong on the queue. IN_REVIEW is work
// awaiting the owner's review; BLOCKED and FAILED are work needing attention
// (aligned with the project workbench's review/attention split, task_query.go).
func workGroup(status string) string {
	switch status {
	case "IN_REVIEW":
		return "review"
	case "BLOCKED", "FAILED":
		return "blocked"
	default:
		return ""
	}
}

// myWork aggregates the caller's actionable items across every project in which
// they hold an active membership. It is an organization-level operation (no
// table/role/queryProject): authentication yields q.user and q.org, and each
// query joins memberships to guarantee zero cross-project leakage. Archived
// projects are excluded (decision D-4) and only active memberships count
// (decision default), so a project-scoped deactivation yields no items.
func myWork(q *request) (reply, error) {
	review, blocked, err := myWorkTasks(q)
	if err != nil {
		return reply{}, err
	}
	approval, err := myWorkApprovals(q)
	if err != nil {
		return reply{}, err
	}
	return reply{status: 200, body: Object{
		"groups": Object{
			"review":   Object{"items": review},
			"approval": Object{"items": approval},
			"blocked":  Object{"items": blocked},
		},
		"checked_at": now(),
	}}, nil
}

// myWorkTasks returns the caller's non-archived tasks that await review or need
// attention, split into the review and blocked groups. Both groups are drawn
// from one query so the transaction holds a single open cursor at a time.
func myWorkTasks(q *request) ([]Object, []Object, error) {
	review, blocked := []Object{}, []Object{}
	rows, err := q.tx.Query(q.http.Context(), `SELECT t.project_id,p.name,t.document
		FROM tasks t
		JOIN projects p ON p.id=t.project_id AND p.organization_id=t.organization_id
		JOIN memberships m ON m.project_id=t.project_id AND m.user_id=$2 AND m.organization_id=t.organization_id AND m.active
		WHERE t.organization_id=$1 AND t.owner_user_id=$2
			AND p.status<>'ARCHIVED'
			AND coalesce(t.document->>'archived','false')='false'
			AND t.document->>'status' IN ('IN_REVIEW','BLOCKED','FAILED')
		ORDER BY t.document->>'updated_at', t.id
		LIMIT $3`, q.org, q.user, workQueueLimit)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var projectID, projectName string
		var data []byte
		if err = rows.Scan(&projectID, &projectName, &data); err != nil {
			return nil, nil, err
		}
		var doc Object
		if err = json.Unmarshal(data, &doc); err != nil {
			return nil, nil, err
		}
		status := textValue(doc, "status")
		item := Object{
			"project_id":    projectID,
			"project_name":  projectName,
			"task_id":       textValue(doc, "id"),
			"title":         textValue(doc, "title"),
			"status":        status,
			"waiting_since": textValue(doc, "updated_at"),
		}
		switch workGroup(status) {
		case "review":
			review = append(review, item)
		case "blocked":
			blocked = append(blocked, item)
		}
	}
	return review, blocked, rows.Err()
}

// myWorkApprovals returns pending approvals in projects where the caller is an
// active REVIEWER or ADMIN. Approval documents carry no timestamp, so the wait
// time comes from the originating invocation's created_at, and the display
// title is the originating task's title (falling back to the bound tool id).
func myWorkApprovals(q *request) ([]Object, error) {
	items := []Object{}
	rows, err := q.tx.Query(q.http.Context(), `SELECT a.project_id,p.name,a.document,
			i.document->>'created_at',
			i.document->'binding'->>'tool_id',
			i.document->'provenance'->>'task_id',
			t.document->>'title'
		FROM approvals a
		JOIN projects p ON p.id=a.project_id AND p.organization_id=a.organization_id
		JOIN memberships m ON m.project_id=a.project_id AND m.user_id=$2 AND m.organization_id=a.organization_id AND m.active
		JOIN tool_invocations i ON i.id=a.invocation_id AND i.project_id=a.project_id AND i.organization_id=a.organization_id
		LEFT JOIN tasks t ON t.id=(i.document->'provenance'->>'task_id') AND t.project_id=a.project_id AND t.organization_id=a.organization_id
		WHERE a.organization_id=$1 AND a.document->>'status'='PENDING'
			AND p.status<>'ARCHIVED'
			AND ('REVIEWER'=ANY(m.roles) OR 'ADMIN'=ANY(m.roles))
		ORDER BY i.document->>'created_at', a.id
		LIMIT $3`, q.org, q.user, workQueueLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var projectID, projectName string
		var data []byte
		var createdAt, toolID, taskID, taskTitle *string
		if err = rows.Scan(&projectID, &projectName, &data, &createdAt, &toolID, &taskID, &taskTitle); err != nil {
			return nil, err
		}
		var doc Object
		if err = json.Unmarshal(data, &doc); err != nil {
			return nil, err
		}
		items = append(items, Object{
			"project_id":    projectID,
			"project_name":  projectName,
			"approval_id":   textValue(doc, "id"),
			"invocation_id": textValue(doc, "invocation_id"),
			"task_id":       nullableText(taskID),
			"title":         approvalTitle(taskTitle, toolID),
			"waiting_since": deref(createdAt),
		})
	}
	return items, rows.Err()
}

// approvalTitle prefers the originating task's title, falling back to the bound
// tool id so an approval row is never blank.
func approvalTitle(taskTitle, toolID *string) string {
	if taskTitle != nil && *taskTitle != "" {
		return *taskTitle
	}
	return deref(toolID)
}

// nullableText preserves SQL NULL as a JSON null rather than an empty string.
func nullableText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

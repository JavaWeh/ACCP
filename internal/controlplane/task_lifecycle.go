package controlplane

import (
	"encoding/json"
)

// Edit is deliberately limited to states without a live Run. Earlier Run
// snapshots and reviews retain their original inputs.
func editTask(q *request) (reply, error) {
	task, err := ownedTask(q)
	if err != nil {
		return reply{}, err
	}
	if task["archived"] == true {
		return reply{}, fail(409, "TASK_ARCHIVED", "Restore the task before editing it.")
	}
	if err = editableTask(task); err != nil {
		return reply{}, err
	}
	var live bool
	if err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM task_runs WHERE task_id=$1 AND status='RUNNING')`, task["id"]).Scan(&live); err != nil {
		return reply{}, err
	}
	if live {
		return reply{}, fail(409, "RUN_ACTIVE", "End the current Run before editing inputs.")
	}
	var valid bool
	if err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM repositories WHERE id=$1 AND project_id=$2 AND organization_id=$3)`, q.body["repository_id"], q.project, q.org).Scan(&valid); err != nil {
		return reply{}, err
	}
	if !valid {
		return reply{}, fail(422, "INVALID_REPOSITORY", "Repository must belong to this project.")
	}
	versions := q.body["context_version_ids"].([]any)
	contextIDs := map[string]bool{}
	contexts := []Object{}
	for _, value := range versions {
		version, e := readDocument(q, "context_versions", value.(string))
		if e != nil || version["status"] != "PUBLISHED" {
			return reply{}, fail(422, "INVALID_CONTEXT", "Each selected Context version must be published in this project.")
		}
		contextID := textValue(version, "context_id")
		if contextIDs[contextID] {
			return reply{}, fail(422, "CONTEXT_CONFLICT", "Select one version of each Context.")
		}
		contextIDs[contextID] = true
		contexts = append(contexts, version)
	}
	for _, field := range []string{"title", "objective", "repository_id", "acceptance_criteria", "context_version_ids"} {
		task[field] = q.body[field]
	}
	task["status"] = "DRAFT"
	if _, err = q.tx.Exec(q.http.Context(), `DELETE FROM task_contexts WHERE task_id=$1`, task["id"]); err != nil {
		return reply{}, err
	}
	for _, version := range contexts {
		if _, err = q.tx.Exec(q.http.Context(), `INSERT INTO task_contexts(task_id,context_id,version_id,project_id,organization_id) VALUES($1,$2,$3,$4,$5)`, task["id"], version["context_id"], version["id"], q.project, q.org); err != nil {
			return reply{}, err
		}
	}
	if _, err = q.tx.Exec(q.http.Context(), `UPDATE tasks SET repository_id=$1,retry_authorized=false WHERE id=$2 AND project_id=$3`, task["repository_id"], task["id"], q.project); err != nil {
		return reply{}, err
	}
	if err = saveTask(q, task); err != nil {
		return reply{}, err
	}
	return entity(200, task), nil
}

func transferTask(q *request) (reply, error) {
	task, err := ownedTask(q)
	if err != nil {
		return reply{}, err
	}
	if task["archived"] == true {
		return reply{}, fail(409, "TASK_ARCHIVED", "Restore the task before transferring ownership.")
	}
	if err = editableTask(task); err != nil {
		return reply{}, err
	}
	target := textValue(q.body, "owner_user_id")
	if target == textValue(task, "owner_user_id") {
		return reply{}, fail(409, "OWNER_UNCHANGED", "Select a different human Owner.")
	}
	var valid bool
	err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.organization_id=$2 AND m.user_id=$3 AND m.active AND u.active)`, q.project, q.org, target).Scan(&valid)
	if err != nil {
		return reply{}, err
	}
	if !valid {
		return reply{}, fail(422, "INVALID_OWNER", "New Owner must be an active human project member.")
	}
	var live bool
	if err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM task_runs WHERE task_id=$1 AND status='RUNNING')`, task["id"]).Scan(&live); err != nil {
		return reply{}, err
	}
	if live {
		return reply{}, fail(409, "RUN_ACTIVE", "End the current Run before transferring ownership.")
	}
	previous := task["owner_user_id"]
	task["owner_user_id"] = target
	task["status"] = "DRAFT"
	if _, err = q.tx.Exec(q.http.Context(), `UPDATE tasks SET owner_user_id=$1,retry_authorized=false WHERE id=$2 AND project_id=$3`, target, task["id"], q.project); err != nil {
		return reply{}, err
	}
	if err = saveTask(q, task); err != nil {
		return reply{}, err
	}
	// Existing Runs retain their original accountable human.
	details, _ := json.Marshal(Object{"previous_owner_user_id": previous, "owner_user_id": target})
	if _, err = q.tx.Exec(q.http.Context(), `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,action,resource_id,resource_version,trace_id,actor_kind,reason,details) VALUES($1,$2,$3,$4,'task.owner_transfer',$5,$6,$7,'HUMAN',$8,$9)`, newID("audit"), q.project, q.org, q.user, task["id"], task["version"], q.trace, q.body["reason"], details); err != nil {
		return reply{}, err
	}
	return entity(200, task), nil
}

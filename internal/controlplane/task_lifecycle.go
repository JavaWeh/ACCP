package controlplane

import (
	"encoding/json"
	"strings"
)

func (s *Server) lifecycleRoutes(routes map[string]operation) {
	routes["GET /api/v1/projects/{id}/context-version-options"] = operation{table: "projects", run: listResources("context_version_options", "")}
	routes["GET /api/v1/projects/{id}/summary"] = operation{table: "projects", run: projectSummary}
	for path, schema := range map[string]string{"changes": "Edit", "owner-transfers": "Transfer", "inputs": "Inputs", "archive": "Reason", "restore": "Reason"} {
		routes["POST /api/v1/tasks/{id}/"+path] = operation{table: "tasks", schema: "Lifecycle" + schema, conditional: true, run: changeTaskLifecycle}
	}
	routes["GET /api/v1/tasks/{id}/changes"] = operation{table: "tasks", run: listResources("task_changes", "task_id")}
}

func changeTaskLifecycle(q *request) (reply, error) {
	task, err := readDocument(q, "tasks", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	if q.session != nil || (task["owner_user_id"] != q.user && !hasRole(q.roles, "ADMIN")) {
		return reply{}, fail(403, "OWNER_REQUIRED", "Only the human Owner or project administrator may change this task.")
	}
	if err = match(q, number(task, "version")); err != nil {
		return reply{}, err
	}
	action := q.http.URL.Path[strings.LastIndex(q.http.URL.Path, "/")+1:]
	if task["archived"] == true && action != "restore" {
		return reply{}, fail(409, "TASK_ARCHIVED", "Restore the task before changing it.")
	}
	var unsettled bool
	err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM task_runs WHERE task_id=$1 AND status='RUNNING') OR EXISTS(SELECT 1 FROM tool_invocations i JOIN task_runs r ON r.id=i.run_id WHERE r.task_id=$1 AND i.status IN ('AWAITING_APPROVAL','READY','RUNNING','UNKNOWN'))`, task["id"]).Scan(&unsettled)
	if err != nil {
		return reply{}, err
	}
	if unsettled {
		return reply{}, fail(409, "TASK_UNSETTLED", "Stop the active Run and resolve all in-flight tool operations first.")
	}
	before, _ := json.Marshal(task)
	switch action {
	case "changes":
		if task["status"] != "DRAFT" {
			return reply{}, fail(409, "DRAFT_REQUIRED", "Only a draft can be edited; use an explicit input update after stopping execution.")
		}
		task["title"] = q.body["title"]
		task["objective"] = q.body["objective"]
		task["acceptance_criteria"] = q.body["acceptance_criteria"]
	case "owner-transfers":
		var valid bool
		err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.organization_id=$2 AND m.user_id=$3 AND m.active AND u.active)`, q.project, q.org, q.body["owner_user_id"]).Scan(&valid)
		if err != nil {
			return reply{}, err
		}
		if !valid {
			return reply{}, fail(422, "INVALID_OWNER", "Owner must be an active human member of this project.")
		}
		task["owner_user_id"] = q.body["owner_user_id"]
		if task["status"] == "READY" {
			task["status"] = "BLOCKED"
		}
		_, err = q.tx.Exec(q.http.Context(), `UPDATE tasks SET owner_user_id=$1,retry_authorized=false WHERE id=$2`, task["owner_user_id"], task["id"])
	case "inputs":
		if task["status"] == "DONE" || task["status"] == "IN_REVIEW" {
			return reply{}, fail(409, "INVALID_TRANSITION", "Completed or review-stage work must be returned before changing inputs.")
		}
		var valid bool
		err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM repositories WHERE id=$1 AND project_id=$2 AND organization_id=$3)`, q.body["repository_id"], q.project, q.org).Scan(&valid)
		if err != nil {
			return reply{}, err
		}
		if !valid {
			return reply{}, fail(422, "INVALID_REPOSITORY", "Repository must belong to this project.")
		}
		versions := q.body["context_version_ids"].([]any)
		seen := map[string]bool{}
		docs := []Object{}
		for _, id := range versions {
			v, e := readDocument(q, "context_versions", id.(string))
			if e != nil {
				return reply{}, fail(422, "INVALID_CONTEXT", "Context must belong to this project.")
			}
			cid := textValue(v, "context_id")
			if seen[cid] {
				return reply{}, fail(422, "CONTEXT_CONFLICT", "Select one version per Context.")
			}
			seen[cid] = true
			docs = append(docs, v)
		}
		_, err = q.tx.Exec(q.http.Context(), `DELETE FROM task_contexts WHERE task_id=$1`, task["id"])
		if err != nil {
			return reply{}, err
		}
		for _, v := range docs {
			_, err = q.tx.Exec(q.http.Context(), `INSERT INTO task_contexts(task_id,context_id,version_id,project_id,organization_id) VALUES($1,$2,$3,$4,$5)`, task["id"], v["context_id"], v["id"], q.project, q.org)
			if err != nil {
				return reply{}, err
			}
		}
		for _, key := range []string{"title", "objective", "acceptance_criteria", "repository_id", "context_version_ids"} {
			task[key] = q.body[key]
		}
		task["input_revision"] = revision(task, "input_revision") + 1
		var attempted bool
		err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM task_runs WHERE task_id=$1)`, task["id"]).Scan(&attempted)
		if err != nil {
			return reply{}, err
		}
		task["status"] = "DRAFT"
		if attempted {
			task["status"] = "BLOCKED"
		}
		_, err = q.tx.Exec(q.http.Context(), `UPDATE tasks SET repository_id=$1,retry_authorized=false WHERE id=$2`, task["repository_id"], task["id"])
	case "archive", "restore":
		if action == "archive" && task["status"] != "DONE" && task["status"] != "CANCELED" {
			return reply{}, fail(409, "TASK_NOT_ENDED", "Only ended tasks may be archived.")
		}
		if action == "restore" && task["archived"] != true {
			return reply{}, fail(409, "TASK_NOT_ARCHIVED", "This task is not archived.")
		}
		task["archived"] = action == "archive"
		_, err = q.tx.Exec(q.http.Context(), `UPDATE tasks SET archived=$1 WHERE id=$2`, task["archived"], task["id"])
	}
	if err != nil {
		return reply{}, err
	}
	if err = saveTask(q, task); err != nil {
		return reply{}, err
	}
	var previous Object
	_ = json.Unmarshal(before, &previous)
	change := Object{"id": newID("change"), "project_id": q.project, "organization_id": q.org, "task_id": task["id"], "version": task["version"], "action": action, "reason": q.body["reason"], "actor_user_id": q.user, "created_at": now(), "before": previous, "after": task}
	data, _ := json.Marshal(change)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO task_changes(id,project_id,organization_id,task_id,version,document) VALUES($1,$2,$3,$4,$5,$6)`, change["id"], q.project, q.org, task["id"], task["version"], data)
	if err != nil {
		return reply{}, err
	}
	err = emitEvent(q, "TASK_CHANGED", textValue(task, "id"), revision(task, "version"), Object{"task_id": task["id"], "change_id": change["id"], "owner_user_id": task["owner_user_id"]})
	return entity(200, task), err
}

package controlplane

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/jackc/pgx/v5"
)

func revision(doc Object, key string) int64 {
	if n, ok := doc[key].(int64); ok {
		return n
	}
	return number(doc, key)
}
func ownedTask(q *request) (Object, error) {
	doc, err := readDocument(q, "tasks", q.http.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if doc["owner_user_id"] != q.user && !hasRole(q.roles, "ADMIN") {
		return nil, fail(403, "OWNER_REQUIRED", "Only the human Owner or administrator may change task execution.")
	}
	if err = match(q, number(doc, "version")); err != nil {
		return nil, err
	}
	return doc, nil
}
func editableTask(doc Object) error {
	if doc["status"] != "DRAFT" && doc["status"] != "READY" && doc["status"] != "BLOCKED" {
		return fail(409, "INVALID_TRANSITION", "Execution inputs can change only before a Run starts.")
	}
	return nil
}
func saveTask(q *request, doc Object) error {
	doc["version"] = revision(doc, "version") + 1
	doc["updated_at"] = now()
	data, _ := json.Marshal(doc)
	_, err := q.tx.Exec(q.http.Context(), `UPDATE tasks SET document=$1,status=$2,version=$3 WHERE id=$4 AND project_id=$5`, data, doc["status"], doc["version"], doc["id"], q.project)
	return err
}
func taskReady(q *request, doc Object) (bool, error) {
	var ready bool
	err := q.tx.QueryRow(q.http.Context(), `SELECT
 NOT EXISTS(SELECT 1 FROM task_contexts tc JOIN context_versions v ON v.id=tc.version_id WHERE tc.task_id=$1 AND v.status<>'PUBLISHED')
 AND EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$2 AND m.user_id=$3 AND m.active AND u.active)
 AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id=d.predecessor_task_id WHERE d.successor_task_id=$1 AND
   CASE WHEN d.condition->>'kind'='TASK_DONE' THEN p.status<>'DONE' ELSE NOT EXISTS(
    SELECT 1 FROM artifacts a JOIN task_runs r ON r.id=a.run_id WHERE r.task_id=p.id AND a.verification_status='VERIFIED' AND a.acceptance_status='ACCEPTED' AND a.document->>'kind'=d.condition->>'artifact_kind') END)`, doc["id"], q.project, doc["owner_user_id"]).Scan(&ready)
	return ready, err
}
func assignTask(q *request) (reply, error) {
	task, err := ownedTask(q)
	if err != nil {
		return reply{}, err
	}
	if err = editableTask(task); err != nil {
		return reply{}, err
	}
	target := q.body["target"].(map[string]any)
	var agent, queue any
	if id := textValue(target, "agent_id"); id != "" {
		if _, err = readDocument(q, "agents", id); err != nil {
			return reply{}, err
		}
		agent = id
	} else {
		// One explicit, vendor-neutral capability queue in M2. Never silently match an unknown queue.
		if target["capability_queue"] != "general" {
			return reply{}, fail(422, "UNSUPPORTED_QUEUE", "M2 supports the general queue for negotiated coding adapters.")
		}
		queue = "general"
	}
	if _, err = q.tx.Exec(q.http.Context(), `UPDATE assignments SET active=false WHERE task_id=$1 AND active`, task["id"]); err != nil {
		return reply{}, err
	}
	doc := Object{"id": newID("assignment"), "project_id": q.project, "organization_id": q.org, "task_id": task["id"], "target": target, "assigned_by_user_id": q.user, "version": int64(1)}
	data, _ := json.Marshal(doc)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO assignments(id,project_id,organization_id,task_id,agent_id,capability_queue,document) VALUES($1,$2,$3,$4,$5,$6,$7)`, doc["id"], q.project, q.org, task["id"], agent, queue, data)
	if err != nil {
		return reply{}, err
	}
	if err = saveTask(q, task); err != nil {
		return reply{}, err
	}
	err = emitEvent(q, "TASK_ASSIGNED", textValue(task, "id"), revision(task, "version"), Object{"task_id": task["id"], "assignment_id": doc["id"], "owner_user_id": task["owner_user_id"]})
	return entity(201, doc), err
}
func addDependency(q *request) (reply, error) {
	task, err := ownedTask(q)
	if err != nil {
		return reply{}, err
	}
	if err = editableTask(task); err != nil {
		return reply{}, err
	}
	pred := textValue(q.body, "predecessor_task_id")
	if _, err = readDocument(q, "tasks", pred); err != nil {
		return reply{}, err
	}
	var invalid bool
	err = q.tx.QueryRow(q.http.Context(), `WITH RECURSIVE reachable(id) AS (SELECT $1::text UNION SELECT d.successor_task_id FROM task_dependencies d JOIN reachable r ON d.predecessor_task_id=r.id WHERE d.project_id=$3) SELECT EXISTS(SELECT 1 FROM reachable WHERE id=$2) OR EXISTS(SELECT 1 FROM task_dependencies WHERE predecessor_task_id=$2 AND successor_task_id=$1)`, task["id"], pred, q.project).Scan(&invalid)
	if err != nil {
		return reply{}, err
	}
	if invalid {
		return reply{}, fail(409, "DEPENDENCY_CONFLICT", "This dependency creates a cycle or already exists.")
	}
	doc := Object{"id": newID("dependency"), "project_id": q.project, "organization_id": q.org, "predecessor_task_id": pred, "successor_task_id": task["id"], "condition": q.body["condition"], "version": int64(1)}
	data, _ := json.Marshal(doc)
	condition, _ := json.Marshal(doc["condition"])
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO task_dependencies(id,project_id,organization_id,predecessor_task_id,successor_task_id,condition,document) VALUES($1,$2,$3,$4,$5,$6,$7)`, doc["id"], q.project, q.org, pred, task["id"], condition, data)
	if err != nil {
		return reply{}, err
	}
	if task["status"] == "READY" {
		ready, e := taskReady(q, task)
		if e != nil {
			return reply{}, e
		}
		if !ready {
			task["status"] = "BLOCKED"
		}
	}
	err = saveTask(q, task)
	return entity(201, doc), err
}
func removeDependency(q *request) (reply, error) {
	task, err := ownedTask(q)
	if err != nil {
		return reply{}, err
	}
	if err = editableTask(task); err != nil {
		return reply{}, err
	}
	tag, err := q.tx.Exec(q.http.Context(), `DELETE FROM task_dependencies WHERE id=$1 AND successor_task_id=$2 AND project_id=$3`, q.http.PathValue("dependency"), task["id"], q.project)
	if err != nil {
		return reply{}, err
	}
	if tag.RowsAffected() != 1 {
		return reply{}, fail(404, "NOT_FOUND", "Dependency not found.")
	}
	err = saveTask(q, task)
	return entity(200, task), err
}
func commandExecution(q *request) (reply, error) {
	doc, err := ownedTask(q)
	if err != nil {
		return reply{}, err
	}
	state := textValue(doc, "status")
	switch q.body["command"] {
	case "SUBMIT", "RETRY":
		if state != "DRAFT" && state != "BLOCKED" {
			return reply{}, fail(409, "INVALID_TRANSITION", "Submit or retry requires DRAFT or BLOCKED.")
		}
		var attempts int
		if err = q.tx.QueryRow(q.http.Context(), `SELECT count(*) FROM task_runs WHERE task_id=$1`, doc["id"]).Scan(&attempts); err != nil {
			return reply{}, err
		}
		if (q.body["command"] == "SUBMIT" && attempts > 0) || (q.body["command"] == "RETRY" && attempts == 0) {
			return reply{}, fail(409, "INVALID_TRANSITION", "Use RETRY only after an ended Run; otherwise use SUBMIT.")
		}
		ready, e := taskReady(q, doc)
		if e != nil {
			return reply{}, e
		}
		doc["status"] = "BLOCKED"
		if ready {
			doc["status"] = "READY"
		}
		if _, err = q.tx.Exec(q.http.Context(), `UPDATE tasks SET retry_authorized=true WHERE id=$1`, doc["id"]); err != nil {
			return reply{}, err
		}
	case "CANCEL":
		if state == "CANCELED" || state == "DONE" {
			return reply{}, fail(409, "INVALID_TRANSITION", "Terminal tasks cannot be canceled.")
		}
		var data []byte
		err = q.tx.QueryRow(q.http.Context(), `SELECT document FROM task_runs WHERE task_id=$1 AND status='RUNNING'`, doc["id"]).Scan(&data)
		if err == nil {
			var run Object
			_ = json.Unmarshal(data, &run)
			run["status"] = "CANCELED"
			if err = saveRun(q, run); err != nil {
				return reply{}, err
			}
		} else if err != pgx.ErrNoRows {
			return reply{}, err
		}
		doc["status"] = "CANCELED"
	default:
		return reply{}, fail(400, "INVALID_COMMAND", "Unsupported command.")
	}
	if err = saveTask(q, doc); err != nil {
		return reply{}, err
	}
	if doc["status"] == "CANCELED" {
		err = emitEvent(q, "TASK_CANCELED", textValue(doc, "id"), revision(doc, "version"), Object{"task_id": doc["id"], "canceled_by_user_id": q.user})
	}
	return entity(200, doc), err
}
func claimRun(q *request) (reply, error) {
	if q.session.Protocol != "0.2" {
		return reply{}, fail(409, "HANDSHAKE_REQUIRED", "Negotiate the adapter before claiming work.")
	}
	var data []byte
	err := q.tx.QueryRow(q.http.Context(), `SELECT t.document FROM tasks t JOIN assignments a ON a.task_id=t.id AND a.active WHERE t.project_id=$1 AND t.status='READY' AND t.retry_authorized AND (a.agent_id=$2 OR a.capability_queue='general') AND ($3='' OR t.id=$3) ORDER BY t.id LIMIT 1`, q.project, q.session.Agent, textValue(q.body, "task_id")).Scan(&data)
	if err == pgx.ErrNoRows {
		return reply{}, fail(409, "NO_CLAIMABLE_TASK", "No authorized, assigned READY task is available.")
	}
	if err != nil {
		return reply{}, err
	}
	var task Object
	_ = json.Unmarshal(data, &task)
	ready, err := taskReady(q, task)
	if err != nil {
		return reply{}, err
	}
	if !ready {
		return reply{}, fail(409, "TASK_BLOCKED", "Task inputs or dependencies are not ready.")
	}
	snapshot, err := freezeSnapshot(q, textValue(task, "id"))
	if err != nil {
		return reply{}, err
	}
	var attempt, fence int64
	var lease time.Time
	err = q.tx.QueryRow(q.http.Context(), `SELECT coalesce(max(attempt),0)+1,nextval('run_fencing_tokens'),clock_timestamp()+interval '90 seconds' FROM task_runs WHERE task_id=$1`, task["id"]).Scan(&attempt, &fence, &lease)
	if err != nil {
		return reply{}, err
	}
	run := Object{"id": newID("run"), "project_id": q.project, "organization_id": q.org, "task_id": task["id"], "session_id": q.session.ID, "agent_id": q.session.Agent, "owner_user_id": task["owner_user_id"], "delegated_by_user_id": q.user, "attempt": attempt, "context_snapshot_id": snapshot["id"], "base_revision": q.body["base_revision"], "status": "RUNNING", "fencing_token": fence, "lease_expires_at": lease.UTC().Format(time.RFC3339Nano), "version": int64(1), "started_at": now()}
	data, _ = json.Marshal(run)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO task_runs(id,task_id,session_id,snapshot_id,project_id,organization_id,document,status,attempt,fencing_token,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'RUNNING',$8,$9,$10)`, run["id"], task["id"], q.session.ID, snapshot["id"], q.project, q.org, data, attempt, fence, lease)
	if err != nil {
		return reply{}, err
	}
	if _, err = q.tx.Exec(q.http.Context(), `UPDATE tasks SET retry_authorized=false WHERE id=$1`, task["id"]); err != nil {
		return reply{}, err
	}
	task["status"] = "RUNNING"
	if err = saveTask(q, task); err != nil {
		return reply{}, err
	}
	err = emitEvent(q, "TASK_STARTED", textValue(task, "id"), revision(task, "version"), Object{"task_id": task["id"], "task_run_id": run["id"], "session_id": q.session.ID, "context_snapshot_id": snapshot["id"]})
	return reply{status: 201, resource: textValue(run, "id"), version: 1, etag: `"1"`, body: Object{"run": run, "snapshot": snapshot, "heartbeat_interval_seconds": 30, "lease_duration_seconds": 90}}, err
}
func freezeSnapshot(q *request, task string) (Object, error) {
	rows, err := q.tx.Query(q.http.Context(), `SELECT tc.context_id,tc.version_id,v.document->>'content_digest' FROM task_contexts tc JOIN context_versions v ON v.id=tc.version_id WHERE tc.task_id=$1 ORDER BY tc.context_id`, task)
	if err != nil {
		return nil, err
	}
	entries := []Object{}
	for rows.Next() {
		var c, v, d string
		if err = rows.Scan(&c, &v, &d); err != nil {
			rows.Close()
			return nil, err
		}
		entries = append(entries, Object{"context_id": c, "context_version_id": v, "content_digest": d})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fail(409, "CONTEXT_REQUIRED", "Execution requires a published Context version.")
	}
	canonical, _ := json.Marshal(entries)
	doc := Object{"id": newID("snapshot"), "project_id": q.project, "organization_id": q.org, "entries": entries, "content_digest": auth.Digest(string(canonical)), "created_at": now()}
	data, _ := json.Marshal(doc)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO context_snapshots(id,project_id,organization_id,document) VALUES($1,$2,$3,$4)`, doc["id"], q.project, q.org, data)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		_, err = q.tx.Exec(q.http.Context(), `INSERT INTO snapshot_entries(snapshot_id,context_id,context_version_id,project_id,organization_id) VALUES($1,$2,$3,$4,$5)`, doc["id"], e["context_id"], e["context_version_id"], q.project, q.org)
		if err != nil {
			return nil, err
		}
	}
	return doc, nil
}
func checkRun(q *request, run Object, live, conditional bool) error {
	if q.session == nil || run["session_id"] != q.session.ID {
		return fail(404, "NOT_FOUND", "Run not found for this Session.")
	}
	if raw := q.http.Header.Get("X-Run-Fencing-Token"); raw != "" && raw != fmt.Sprint(revision(run, "fencing_token")) {
		return fail(409, "STALE_FENCE", "The Run fencing token does not match.")
	}
	if live {
		expiry, _ := time.Parse(time.RFC3339Nano, textValue(run, "lease_expires_at"))
		if run["status"] != "RUNNING" || !time.Now().Before(expiry) {
			return fail(409, "RUN_INACTIVE", "The Run ended or its lease expired.")
		}
		var active bool
		err := q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND u.active)`, q.project, run["owner_user_id"]).Scan(&active)
		if err != nil {
			return err
		}
		if !active {
			return fail(403, "OWNER_INACTIVE", "The human Owner is inactive.")
		}
	}
	if conditional {
		return match(q, number(run, "version"))
	}
	return nil
}
func activeRun(q *request, conditional bool) (Object, error) {
	run, err := readDocument(q, "task_runs", q.http.PathValue("id"))
	if err != nil {
		return nil, err
	}
	return run, checkRun(q, run, true, conditional)
}
func saveRun(q *request, doc Object) error {
	doc["version"] = revision(doc, "version") + 1
	data, _ := json.Marshal(doc)
	_, err := q.tx.Exec(q.http.Context(), `UPDATE task_runs SET document=$1,status=$2,version=$3,lease_expires_at=$4 WHERE id=$5 AND project_id=$6`, data, doc["status"], doc["version"], doc["lease_expires_at"], doc["id"], q.project)
	return err
}
func getRun(q *request) (reply, error) {
	run, err := readDocument(q, "task_runs", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	if q.session != nil && run["session_id"] != q.session.ID {
		return reply{}, fail(404, "NOT_FOUND", "Run not found.")
	}
	return entity(200, run), nil
}
func getSnapshot(q *request) (reply, error) {
	if q.session != nil {
		var allowed bool
		err := q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM task_runs WHERE snapshot_id=$1 AND session_id=$2)`, q.http.PathValue("id"), q.session.ID).Scan(&allowed)
		if err != nil {
			return reply{}, err
		}
		if !allowed {
			return reply{}, fail(404, "NOT_FOUND", "Snapshot not found.")
		}
	}
	doc, err := readDocument(q, "context_snapshots", q.http.PathValue("id"))
	return reply{status: 200, body: doc}, err
}
func heartbeatRun(q *request) (reply, error) {
	run, err := activeRun(q, true)
	if err != nil {
		return reply{}, err
	}
	var lease time.Time
	var changed bool
	err = q.tx.QueryRow(q.http.Context(), `SELECT clock_timestamp()+interval '90 seconds',EXISTS(SELECT 1 FROM snapshot_entries e JOIN contexts c ON c.id=e.context_id WHERE e.snapshot_id=$1 AND c.document->>'current_published_version_id' IS DISTINCT FROM e.context_version_id)`, run["context_snapshot_id"]).Scan(&lease, &changed)
	if err != nil {
		return reply{}, err
	}
	run["lease_expires_at"] = lease.UTC().Format(time.RFC3339Nano)
	if err = saveRun(q, run); err != nil {
		return reply{}, err
	}
	r := entity(200, run)
	r.body = Object{"run": run, "cancel_requested": false, "context_update_available": changed}
	return r, nil
}
func reportRun(q *request) (reply, error) {
	run, err := activeRun(q, true)
	if err != nil {
		return reply{}, err
	}
	task, err := readDocument(q, "tasks", textValue(run, "task_id"))
	if err != nil {
		return reply{}, err
	}
	kind := textValue(q.body, "kind")
	if len(textValue(q.body, "error_code")) > 128 {
		return reply{}, fail(422, "INVALID_ERROR_CODE", "error_code must be at most 128 bytes; detailed output belongs in evidence.")
	}
	if kind == "COMPLETION_CANDIDATE" {
		for _, id := range q.body["artifact_ids"].([]any) {
			var valid bool
			err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=$1 AND run_id=$2 AND verification_status='VERIFIED')`, id, run["id"]).Scan(&valid)
			if err != nil {
				return reply{}, err
			}
			if !valid {
				return reply{}, fail(422, "ARTIFACT_EVIDENCE_REQUIRED", "Every completion artifact must be verified and belong to this Run.")
			}
		}
		run["status"] = "SUCCEEDED"
		task["status"] = "IN_REVIEW"
	} else if kind == "FAILURE" {
		run["status"] = "FAILED"
		task["status"] = "BLOCKED"
	}
	data, _ := json.Marshal(q.body)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO run_reports(id,run_id,project_id,organization_id,document) VALUES($1,$2,$3,$4,$5)`, newID("report"), run["id"], q.project, q.org, data)
	if err != nil {
		return reply{}, err
	}
	if err = saveRun(q, run); err != nil {
		return reply{}, err
	}
	if kind != "PROGRESS" {
		if err = saveTask(q, task); err != nil {
			return reply{}, err
		}
		data := Object{"task_id": task["id"], "task_run_id": run["id"], "context_snapshot_id": run["context_snapshot_id"]}
		event := "TASK_FAILED"
		if kind == "COMPLETION_CANDIDATE" {
			event = "REVIEW_REQUIRED"
			data["artifact_ids"] = q.body["artifact_ids"]
			data["owner_user_id"] = task["owner_user_id"]
		} else {
			data["error_code"] = q.body["error_code"]
			data["run_status"] = "FAILED"
		}
		err = emitEvent(q, event, textValue(task, "id"), revision(task, "version"), data)
	}
	return entity(200, run), err
}

package controlplane

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Reconcile closes lost Runs and rechecks dependency-blocked work. It never authorizes a retry.
func (s *Server) Reconcile(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT id,organization_id FROM projects ORDER BY id`)
	if err != nil {
		return err
	}
	type project struct{ id, org string }
	projects := []project{}
	for rows.Next() {
		var p project
		if err = rows.Scan(&p.id, &p.org); err != nil {
			rows.Close()
			return err
		}
		projects = append(projects, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, p := range projects {
		if err = s.reconcileProject(ctx, p.id, p.org); err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) reconcileProject(ctx context.Context, project, org string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE SKIP LOCKED`, project).Scan(&id)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://worker/reconcile", nil)
	q := &request{tx: tx, http: req, project: project, org: org, trace: newID("trace"), server: s}
	rows, err := tx.Query(ctx, `SELECT r.document FROM task_runs r JOIN agent_sessions s ON s.id=r.session_id WHERE r.project_id=$1 AND r.status='RUNNING' AND
 (r.lease_expires_at<=clock_timestamp() OR s.status<>'ACTIVE' OR s.expires_at<=clock_timestamp() OR NOT EXISTS(
 SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=s.delegated_by_user_id AND m.active AND u.active AND ('MEMBER'=ANY(m.roles) OR 'ADMIN'=ANY(m.roles))) OR NOT EXISTS(
 SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=r.document->>'owner_user_id' AND m.active AND u.active))`, project)
	if err != nil {
		return err
	}
	runs := []Object{}
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data); err != nil {
			rows.Close()
			return err
		}
		var doc Object
		_ = json.Unmarshal(data, &doc)
		runs = append(runs, doc)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, run := range runs {
		run["status"] = "LOST"
		if err = saveRun(q, run); err != nil {
			return err
		}
		task, e := readDocument(q, "tasks", textValue(run, "task_id"))
		if e != nil {
			return e
		}
		task["status"] = "BLOCKED"
		if err = saveTask(q, task); err != nil {
			return err
		}
		err = emitEvent(q, "TASK_FAILED", textValue(task, "id"), revision(task, "version"), Object{"task_id": task["id"], "task_run_id": run["id"], "context_snapshot_id": run["context_snapshot_id"], "error_code": "EXECUTION_AUTHORITY_LOST", "run_status": "LOST"})
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,action,resource_id,resource_version,trace_id,actor_kind,task_run_id,owner_user_id,context_snapshot_id) VALUES($1,$2,$3,$4,'worker.reconcile',$5,$6,$7,'SERVICE',$5,$8,$9)`, newID("audit"), project, org, run["delegated_by_user_id"], run["id"], run["version"], q.trace, run["owner_user_id"], run["context_snapshot_id"])
		if err != nil {
			return err
		}
	}
	rows, err = tx.Query(ctx, `SELECT document FROM tasks WHERE project_id=$1 AND status='BLOCKED' AND retry_authorized`, project)
	if err != nil {
		return err
	}
	tasks := []Object{}
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data); err != nil {
			rows.Close()
			return err
		}
		var doc Object
		_ = json.Unmarshal(data, &doc)
		tasks = append(tasks, doc)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, task := range tasks {
		ready, e := taskReady(q, task)
		if e != nil {
			return e
		}
		if ready {
			task["status"] = "READY"
			if err = saveTask(q, task); err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,action,resource_id,resource_version,trace_id,actor_kind,owner_user_id) VALUES($1,$2,$3,$4,'worker.dependencies_ready',$5,$6,$7,'SERVICE',$4)`, newID("audit"), project, org, task["owner_user_id"], task["id"], task["version"], q.trace)
			if err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

package recovery

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/JavaWeh/ACCP/internal/buildinfo"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"strings"
	"time"
)

// Handoff writes a bounded diagnostic summary or a consistent project audit snapshot.
// Cleanup is intentionally restricted to expired idempotency data, never business evidence.
func Handoff(ctx context.Context, url, action, output, actor, project, reason string, execute bool) error {
	if actor == "" || project == "" || strings.TrimSpace(reason) == "" {
		return errors.New("actor, project and reason required")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return errors.New("database configuration unavailable")
	}
	defer pool.Close()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialize with project authority changes and re-check the current actor in
	// the same snapshot that is exported or cleaned. Never freeze a stale grant.
	var lockedProject string
	if err = tx.QueryRow(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project).Scan(&lockedProject); err != nil {
		return errors.New("current project ADMIN required")
	}
	var allowed bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users h ON h.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND h.active AND 'ADMIN'=ANY(m.roles))`, project, actor).Scan(&allowed)
	if err != nil || !allowed {
		return errors.New("current project ADMIN required")
	}
	if action == "cleanup" {
		var expired int64
		err = tx.QueryRow(ctx, `SELECT count(*) FROM idempotency_records WHERE project_id=$1 AND expires_at<now()`, project).Scan(&expired)
		if err != nil {
			return err
		}
		if !execute {
			return json.NewEncoder(os.Stdout).Encode(map[string]any{"dry_run": true, "project_id": project, "expired_idempotency_records": expired, "business_records_deleted": 0})
		}
		if _, err = tx.Exec(ctx, `DELETE FROM idempotency_records WHERE project_id=$1 AND expires_at<now()`, project); err != nil {
			return err
		}
		// Keep an immutable, project-scoped record even when no expired keys exist.
		if _, err = tx.Exec(ctx, `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,action,resource_id,resource_version,trace_id,reason,details) SELECT $1,p.id,p.organization_id,$2,'LOCAL_CLEANUP',p.id,1,$1,$3,jsonb_build_object('expired_idempotency_records',$4::bigint,'business_records_deleted',0) FROM projects p WHERE p.id=$5`, "cleanup_"+time.Now().UTC().Format("20060102T150405.000000000"), actor, reason, expired, project); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if action != "audit-export" && action != "diagnostics" {
		return errors.New("unsupported handoff action")
	}
	file, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	success := false
	defer func() {
		file.Close()
		if !success {
			os.Remove(output)
		}
	}()
	encoder := json.NewEncoder(file)
	if action == "audit-export" {
		if err = encoder.Encode(map[string]any{"format": "accp-audit-ndjson/v1", "project_id": project, "exported_at": time.Now().UTC(), "actor_user_id": actor, "reason": reason, "snapshot": "REPEATABLE READ"}); err != nil {
			return err
		}
		rows, e := tx.Query(ctx, `SELECT to_jsonb(a) FROM audit_records a WHERE project_id=$1 ORDER BY id`, project)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var raw json.RawMessage
			if e = rows.Scan(&raw); e != nil {
				return e
			}
			if e = encoder.Encode(raw); e != nil {
				return e
			}
		}
		if e = rows.Err(); e != nil {
			return e
		}
	} else {
		info := map[string]any{"format": "accp-diagnostics/v1", "project_id": project, "collected_at": time.Now().UTC(), "version": buildinfo.Version, "revision": buildinfo.Revision, "reason": reason}
		var state json.RawMessage
		err = tx.QueryRow(ctx, `SELECT jsonb_build_object('maintenance',maintenance,'recovery_pending',recovery_pending) FROM runtime_state WHERE id='default'`).Scan(&state)
		if err != nil {
			return err
		}
		info["runtime"] = state
		counts := map[string]int64{}
		for _, table := range []string{"tasks", "task_runs", "context_snapshots", "artifacts", "audit_records", "tool_invocations"} {
			var count int64
			if err = tx.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE project_id=$1`, project).Scan(&count); err != nil {
				return err
			}
			counts[table] = count
		}
		info["counts"] = counts
		rows, e := tx.Query(ctx, `SELECT name,checksum FROM schema_migrations ORDER BY name`)
		if e != nil {
			return e
		}
		migrations := map[string]string{}
		for rows.Next() {
			var name, checksum string
			if e = rows.Scan(&name, &checksum); e != nil {
				rows.Close()
				return e
			}
			migrations[name] = checksum
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		info["migrations"] = migrations
		if err = encoder.Encode(info); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	success = true
	return nil
}

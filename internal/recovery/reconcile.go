package recovery

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
)

// Resolve records human evidence. Tool items require an outcome already confirmed
// through the governed lookup API; this command cannot invent a tool result.
func Resolve(ctx context.Context, url, item, actor, evidence string) error {
	if evidence == "" || len(evidence) > 2000 {
		return errors.New("bounded reconciliation evidence required")
	}
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		return errors.New("database unavailable")
	}
	defer db.Close(ctx)
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SET LOCAL search_path=accp,public`); err != nil {
		return err
	}
	var paused bool
	if err = tx.QueryRow(ctx, `SELECT maintenance FROM runtime_state WHERE id='default' FOR UPDATE`).Scan(&paused); err != nil {
		return err
	}
	if !paused {
		return errors.New("recovery resolution requires maintenance")
	}
	var project, kind, resource string
	if err = tx.QueryRow(ctx, `SELECT project_id,kind,resource_id FROM recovery_items WHERE id=$1 AND resolved_at IS NULL FOR UPDATE`, item).Scan(&project, &kind, &resource); err != nil {
		return errors.New("unresolved recovery item unavailable")
	}
	var admin bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users h ON h.id=m.user_id WHERE m.project_id=$1 AND h.id=$2 AND h.active AND m.active AND 'ADMIN'=ANY(m.roles))`, project, actor).Scan(&admin); err != nil {
		return err
	}
	if !admin {
		return errors.New("actor must administer this project")
	}
	if kind == "TOOL" {
		var terminal bool
		if err = tx.QueryRow(ctx, `SELECT status IN ('SUCCEEDED','FAILED') FROM tool_invocations WHERE id=$1 AND project_id=$2`, resource, project).Scan(&terminal); err != nil {
			return err
		}
		if !terminal {
			return errors.New("confirm the UNKNOWN outcome through the governed reconciliation API first")
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE recovery_items SET resolved_at=clock_timestamp(),resolved_by=$2,evidence=$3 WHERE id=$1`, item, actor, evidence); err != nil {
		return err
	}
	detail, _ := json.Marshal(map[string]string{"item": item, "resource_id": resource, "project_id": project})
	if _, err = tx.Exec(ctx, `INSERT INTO maintenance_records(operation_id,action,actor_id,reason,phase,details) VALUES($1,'recovery.resolve',$2,$3,'SUCCEEDED',$4)`, item, actor, evidence, detail); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func Finish(ctx context.Context, url, actor, evidence string) error {
	if evidence == "" || len(evidence) > 2000 {
		return errors.New("bounded verification evidence required")
	}
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		return errors.New("database unavailable")
	}
	defer db.Close(ctx)
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SET LOCAL search_path=accp,public`); err != nil {
		return err
	}
	var paused bool
	if err = tx.QueryRow(ctx, `SELECT maintenance FROM runtime_state WHERE id='default' FOR UPDATE`).Scan(&paused); err != nil {
		return err
	}
	if !paused {
		return errors.New("finish verification requires maintenance")
	}
	var allowed bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users h ON h.id=m.user_id WHERE h.id=$1 AND h.active AND m.active AND 'ADMIN'=ANY(m.roles)) AND NOT EXISTS(SELECT 1 FROM recovery_items WHERE resolved_at IS NULL) AND NOT EXISTS(SELECT 1 FROM tool_invocations WHERE status IN ('UNKNOWN','RUNNING')) AND NOT EXISTS(SELECT 1 FROM agent_sessions WHERE status='ACTIVE')`, actor).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return errors.New("current administrator, resolved items, no UNKNOWN/in-flight tools and revoked Sessions required")
	}
	if _, err = tx.Exec(ctx, `UPDATE runtime_state SET recovery_pending=false,reason=$1,changed_at=clock_timestamp() WHERE id='default'`, evidence); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO maintenance_records(operation_id,action,actor_id,reason,phase) VALUES('recovery_finish_'||md5(clock_timestamp()::text),'recovery.finish',$1,$2,'SUCCEEDED')`, actor, evidence); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

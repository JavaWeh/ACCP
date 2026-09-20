package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"strings"
)

// maintenance is deliberately available only to a local database operator.
func maintenance(ctx context.Context, pool *pgxpool.Pool, args []string) (result error) {
	flags := flag.NewFlagSet("maintenance", flag.ContinueOnError)
	action := flags.String("action", "status", "status|check|enter|leave")
	actor := flags.String("actor", "", "accountable current administrator")
	reason := flags.String("reason", "", "maintenance reason")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected maintenance arguments")
	}
	if *action == "status" || *action == "check" {
		var paused, recovery bool
		var running, pending int64
		if err := pool.QueryRow(ctx, `SELECT maintenance,recovery_pending,(SELECT count(*) FROM tool_invocations WHERE status='RUNNING'),(SELECT count(*) FROM recovery_items WHERE resolved_at IS NULL) FROM runtime_state WHERE id='default'`).Scan(&paused, &recovery, &running, &pending); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"maintenance": paused, "recovery_pending": recovery, "running_tools": running, "unresolved_items": pending, "can_enter": running == 0, "can_leave": pending == 0 && !recovery})
	}
	if (*action != "enter" && *action != "leave") || strings.TrimSpace(*actor) == "" || strings.TrimSpace(*reason) == "" || len(*reason) > 2000 {
		return errors.New("enter|leave requires actor and bounded reason")
	}
	var admin bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users h ON h.id=m.user_id WHERE h.id=$1 AND h.active AND m.active AND 'ADMIN'=ANY(m.roles))`, *actor).Scan(&admin); err != nil {
		return err
	}
	if !admin {
		return errors.New("actor must be a current administrator")
	}
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return err
	}
	id := "maintenance_" + hex.EncodeToString(entropy[:])
	if _, err := pool.Exec(ctx, `INSERT INTO maintenance_records(operation_id,action,actor_id,reason,phase) VALUES($1,$2,$3,$4,'STARTED')`, id, *action, *actor, *reason); err != nil {
		return err
	}
	defer func() {
		if result != nil {
			// Do not put database diagnostics, parameters or credentials in the journal.
			recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5e9)
			defer cancel()
			_, _ = pool.Exec(recordCtx, `INSERT INTO maintenance_records(operation_id,action,actor_id,reason,phase,details) VALUES($1,$2,$3,$4,'FAILED','{"code":"MAINTENANCE_INCOMPLETE"}')`, id, *action, *actor, *reason)
		}
	}()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var recovery bool
	if err = tx.QueryRow(ctx, `SELECT recovery_pending FROM runtime_state WHERE id='default' FOR UPDATE`).Scan(&recovery); err != nil {
		return err
	}
	var running, pending int64
	if err = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM tool_invocations WHERE status='RUNNING'),(SELECT count(*) FROM recovery_items WHERE resolved_at IS NULL)`).Scan(&running, &pending); err != nil {
		return err
	}
	if *action == "enter" && running > 0 {
		return errors.New("tools are still in flight; wait for completion or UNKNOWN before retrying maintenance")
	}
	if *action == "leave" && (recovery || pending > 0) {
		return errors.New("recovery verification and reconciliation must finish before resuming")
	}
	if _, err = tx.Exec(ctx, `UPDATE runtime_state SET maintenance=$1,reason=$2,changed_at=clock_timestamp() WHERE id='default'`, *action == "enter", *reason); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO maintenance_records(operation_id,action,actor_id,reason,phase) VALUES($1,$2,$3,$4,'SUCCEEDED')`, id, *action, *actor, *reason); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"operation_id": id, "maintenance": *action == "enter"})
}

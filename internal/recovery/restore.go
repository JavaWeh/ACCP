package recovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
)

type RestoreReport struct {
	Manifest    Manifest `json:"manifest"`
	RPOSeconds  float64  `json:"rpo_seconds"`
	RTOSeconds  float64  `json:"rto_seconds"`
	Verified    bool     `json:"verified"`
	Maintenance bool     `json:"maintenance"`
	Pending     int64    `json:"pending_reconciliation"`
}

// Restore requires a new isolated database. No existing schema is dropped or
// overwritten. The archive has no grants: runtime access is installed only after
// this command has committed its verification and quarantine transaction.
func Restore(ctx context.Context, url, input, identity, actor, reason string, incident time.Time) (RestoreReport, error) {
	started := time.Now()
	var report RestoreReport
	temp, err := os.MkdirTemp("", "accp-restore-")
	if err != nil {
		return report, err
	}
	defer os.RemoveAll(temp)
	m, dump, err := Open(input, identity, temp)
	if err != nil {
		return report, err
	}
	report.Manifest = m
	if incident.Before(m.SnapshotAt) {
		return report, errors.New("incident time precedes backup snapshot")
	}
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		return report, errors.New("restore database unavailable")
	}
	defer db.Close(ctx)
	var occupied bool
	if err = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%') OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public') OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())`).Scan(&occupied); err != nil {
		return report, err
	}
	if occupied {
		return report, errors.New("restore requires an empty database with no other connections")
	}
	// No --clean, no ownership or ACL replay. Failed restores require another new database.
	if err = command(ctx, url, "pg_restore", "--dbname="+"", "--no-owner", "--no-privileges", "--single-transaction", dump).Run(); err != nil {
		return report, errors.New("database restore failed; retain isolation and use a new empty database for retry")
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return report, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SET LOCAL search_path=accp,public`); err != nil {
		return report, err
	}
	actual, err := Fingerprints(ctx, tx)
	if err != nil {
		return report, err
	}
	if !reflect.DeepEqual(m.Tables, actual) {
		return report, errors.New("restored table fingerprints differ; do not grant runtime access")
	}
	var admin bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users h ON h.id=m.user_id WHERE h.id=$1 AND h.active AND m.active AND 'ADMIN'=ANY(m.roles))`, actor).Scan(&admin); err != nil {
		return report, err
	}
	if !admin || reason == "" {
		return report, errors.New("restore requires accountable administrator and reason")
	}
	// All non-final work may have advanced after the snapshot. Never infer an
	// external outcome from database age, an old Session, or an event delivery.
	err = Quarantine(ctx, tx)
	if err != nil {
		return report, fmt.Errorf("restore quarantine failed (%T); do not grant runtime access", err)
	}
	detail, _ := json.Marshal(map[string]any{"snapshot_at": m.SnapshotAt, "dump_sha256": m.DumpSHA256, "tables_verified": len(actual)})
	if _, err = tx.Exec(ctx, `INSERT INTO maintenance_records(operation_id,action,actor_id,reason,phase,details) VALUES($1,'restore',$2,$3,'SUCCEEDED',$4)`, "restore_"+started.UTC().Format("20060102T150405.000000000"), actor, reason, detail); err != nil {
		return report, err
	}
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM recovery_items WHERE resolved_at IS NULL`).Scan(&report.Pending); err != nil {
		return report, err
	}
	if err = tx.Commit(ctx); err != nil {
		return report, err
	}
	report.Verified = true
	report.Maintenance = true
	report.RPOSeconds = incident.Sub(m.SnapshotAt).Seconds()
	report.RTOSeconds = time.Since(started).Seconds()
	return report, nil
}

package database

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// RuntimeAllowed holds the gate until the caller's transaction finishes. Taking
// this lock before project locks serializes new work with local maintenance.
func RuntimeAllowed(ctx context.Context, tx pgx.Tx) (bool, error) {
	var paused bool
	err := tx.QueryRow(ctx, `SELECT maintenance FROM runtime_state WHERE id='default' FOR SHARE`).Scan(&paused)
	return !paused, err
}

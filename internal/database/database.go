package database

import (
	"context"
	"crypto/sha256"
	"embed"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	if url == "" {
		return nil, fmt.Errorf("DATABASE_URL is required; driver defaults are disabled")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("invalid database configuration")
	}
	cfg.MaxConns = 10
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("database unavailable")
	}
	return pool, nil
}

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(1094927184)`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)`); err != nil {
		return err
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		data, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		digest := fmt.Sprintf("%x", sha256.Sum256(data))
		var stored string
		err = tx.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE name=$1`, entry.Name()).Scan(&stored)
		if err == nil {
			if stored != digest {
				return fmt.Errorf("migration checksum mismatch: %s", entry.Name())
			}
			continue
		}
		if err != pgx.ErrNoRows {
			return err
		}
		if _, err = tx.Exec(ctx, string(data)); err != nil {
			return fmt.Errorf("migration %s: %w", entry.Name(), err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)`, entry.Name(), digest); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func Ready(ctx context.Context, pool *pgxpool.Pool) error {
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil {
		return err
	}
	if count != len(entries) {
		return fmt.Errorf("migration version mismatch")
	}
	for _, e := range entries {
		data, err := migrations.ReadFile("migrations/" + e.Name())
		if err != nil {
			return err
		}
		var digest string
		if err = pool.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE name=$1`, e.Name()).Scan(&digest); err != nil {
			return err
		}
		if digest != fmt.Sprintf("%x", sha256.Sum256(data)) {
			return fmt.Errorf("migration checksum mismatch")
		}
	}
	return nil
}

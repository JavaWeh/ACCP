package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/JavaWeh/ACCP/internal/config"
	"github.com/JavaWeh/ACCP/internal/controlplane"
	"github.com/JavaWeh/ACCP/internal/eventbus"
	"github.com/jackc/pgx/v5/pgxpool"
)

func work(ctx context.Context, pool *pgxpool.Pool, c config.Execution) error {
	server, err := controlplane.New(pool, nil, controlplane.Options{SessionKey: c.SessionKey, PublicURL: c.PublicURL})
	if err != nil {
		return err
	}
	schemas, err := controlplane.NewValidator()
	if err != nil {
		return err
	}
	startup, cancel := context.WithTimeout(ctx, 20*time.Second)
	worker, err := eventbus.New(startup, pool, c.NATSURL, c.NATSToken, c.EventNamespace, schemas["M2Event"].Validate)
	cancel()
	if err != nil {
		return err
	}
	defer worker.Close()
	stopped := make(chan error, 1)
	go func() { stopped <- worker.Run(ctx) }()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	slog.Info("ACCP M2 worker started")
	for {
		select {
		case <-ctx.Done():
			return <-stopped
		case err = <-stopped:
			return err
		case <-ticker.C:
			step, cancel := context.WithTimeout(ctx, 10*time.Second)
			if err = server.Reconcile(step); err != nil {
				slog.Warn("execution reconciliation deferred")
			}
			cancel()
		}
	}
}

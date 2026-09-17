package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/JavaWeh/ACCP/internal/controlplane"
	"github.com/JavaWeh/ACCP/internal/eventbus"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"time"
)

// checkEvents isolates event stages on the dedicated benchmark database.
func checkEvents(ctx context.Context, pool *pgxpool.Pool) error {
	validators, err := controlplane.NewValidator()
	if err != nil {
		return err
	}
	worker, err := eventbus.New(ctx, pool, os.Getenv("ACCP_NATS_URL"), "", "CAPACITY", validators["M2Event"].Validate)
	if err != nil {
		return err
	}
	defer worker.Close()
	for _, stage := range []struct {
		name string
		run  func(context.Context) error
	}{{"relay", worker.RelayOne}, {"consume", worker.ConsumeOne}, {"drain", func(c context.Context) error { return worker.Drain(c, 64) }}} {
		started := time.Now()
		step, cancel := context.WithTimeout(ctx, 10*time.Second)
		err = stage.run(step)
		cancel()
		json.NewEncoder(os.Stdout).Encode(object{"stage": stage.name, "elapsed_ms": time.Since(started).Milliseconds(), "error_type": fmt.Sprintf("%T", err)})
		if err != nil {
			return err
		}
	}
	return nil
}

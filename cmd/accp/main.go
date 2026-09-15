package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/JavaWeh/ACCP/internal/bootstrap"
	"github.com/JavaWeh/ACCP/internal/config"
	"github.com/JavaWeh/ACCP/internal/controlplane"
	"github.com/JavaWeh/ACCP/internal/database"
	"github.com/JavaWeh/ACCP/internal/gateway"
	"github.com/JavaWeh/ACCP/internal/gitprovider"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		slog.Error("accp stopped", "reason", err.Error())
		os.Exit(1)
	}
}

func run() error {
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	if command != "serve" && command != "migrate" && command != "bootstrap" && command != "worker" {
		return fmt.Errorf("usage: accp serve | worker | migrate | bootstrap [-development -output FILE | -file FILE]")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pool, err := database.Open(startup, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	switch command {
	case "migrate":
		if err = database.Migrate(startup, pool); err != nil {
			return fmt.Errorf("migration failed (%T)", err)
		}
		slog.Info("migrations current")
		return nil
	case "bootstrap":
		return provision(startup, pool, os.Args[2:])
	}
	execution, err := config.LoadExecution()
	if err != nil {
		return err
	}
	if err = database.Ready(startup, pool); err != nil {
		return fmt.Errorf("database migrations are not current; run accp migrate")
	}
	if command == "worker" {
		return work(ctx, pool, execution)
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err = database.Ready(startup, pool); err != nil {
		return fmt.Errorf("database migrations are not current; run accp migrate")
	}
	var verifier auth.Authenticator
	if cfg.AuthMode == "development" {
		verifier = auth.Development{Pool: pool}
	} else {
		verifier, err = auth.NewOIDC(startup, cfg.Issuer, cfg.Audience)
		if err != nil {
			return err
		}
	}
	tools, err := gateway.Load(os.Getenv("ACCP_TOOLS_FILE"), os.Getenv("ACCP_ENV") == "development")
	if err != nil {
		return err
	}
	handler, err := controlplane.New(pool, verifier, controlplane.Options{SessionKey: execution.SessionKey, PublicURL: execution.PublicURL, GitProvider: &gitprovider.GitHub{Token: os.Getenv("ACCP_GITHUB_TOKEN")}, Tools: tools, WebDirectory: os.Getenv("ACCP_WEB_DIR"), AuthMode: cfg.AuthMode, OIDCIssuer: cfg.Issuer, OIDCClientID: cfg.Audience})
	if err != nil {
		return fmt.Errorf("contract initialization failed: %w", err)
	}
	server := &http.Server{Addr: cfg.ListenAddress, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768}
	stopped := make(chan error, 1)
	go func() { stopped <- server.ListenAndServe() }()
	slog.Info("ACCP control plane listening", "address", cfg.ListenAddress, "auth_mode", cfg.AuthMode)
	select {
	case err := <-stopped:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("HTTP server failed")
		}
		return nil
	case <-ctx.Done():
		shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if err = server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return fmt.Errorf("HTTP shutdown timed out")
		}
		return nil
	}
}

func provision(ctx context.Context, pool *pgxpool.Pool, args []string) error {
	flags := flag.NewFlagSet("bootstrap", flag.ContinueOnError)
	development := flags.Bool("development", false, "provision two local development humans")
	file := flags.String("file", "", "operator-maintained OIDC human mapping JSON")
	output := flags.String("output", "", "new private development credential file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected bootstrap arguments")
	}
	spec := bootstrap.DevelopmentSpec()
	var credentialFile *os.File
	if *development {
		if os.Getenv("ACCP_ENV") != "development" || os.Getenv("ACCP_AUTH_MODE") != "development" || *file != "" || *output == "" {
			return fmt.Errorf("development bootstrap requires explicit development environment/auth mode and -output, without -file")
		}
		f, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return fmt.Errorf("cannot create credential file exclusively")
		}
		credentialFile = f
		defer f.Close()
	} else {
		if *file == "" || *output != "" {
			return fmt.Errorf("OIDC bootstrap requires -file and no -output")
		}
		f, err := os.Open(*file)
		if err != nil {
			return fmt.Errorf("cannot read bootstrap file")
		}
		defer f.Close()
		spec = bootstrap.Spec{}
		decoder := json.NewDecoder(io.LimitReader(f, 1024*1024))
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&spec); err != nil {
			return fmt.Errorf("invalid bootstrap JSON")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return fmt.Errorf("unexpected data after bootstrap JSON")
		}
	}
	credentials, err := bootstrap.Apply(ctx, pool, spec, *development)
	if err != nil {
		return fmt.Errorf("bootstrap failed: %w", sanitizeBootstrap(err))
	}
	if credentialFile != nil {
		if err = json.NewEncoder(credentialFile).Encode(credentials); err != nil {
			return fmt.Errorf("bootstrap committed but credential file write failed")
		}
		if err = credentialFile.Sync(); err != nil {
			return fmt.Errorf("bootstrap committed but credential file sync failed")
		}
	}
	slog.Info("bootstrap complete", "humans", len(spec.Humans), "projects", len(spec.Projects))
	return nil
}

func sanitizeBootstrap(err error) error {
	// Database diagnostics can contain operator-provided values. Keep those out of logs.
	if fmt.Sprintf("%T", err) == "*pgconn.PgError" {
		return fmt.Errorf("database constraint rejected the mapping")
	}
	return err
}

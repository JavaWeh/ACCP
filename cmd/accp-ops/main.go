// accp-ops runs only on the operator host or its explicitly mounted tools container.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"filippo.io/age"
	"github.com/JavaWeh/ACCP/internal/buildinfo"
	"github.com/JavaWeh/ACCP/internal/recovery"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "operation failed:", err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		return buildinfo.Write(os.Stdout)
	}
	if len(os.Args) < 2 {
		return errors.New("usage: accp-ops keygen|backup|verify-backup|restore")
	}
	action := os.Args[1]
	f := flag.NewFlagSet(action, flag.ContinueOnError)
	input := f.String("input", "", "encrypted backup")
	output := f.String("output", "", "new output file")
	identity := f.String("identity-file", "", "offline private identity")
	recipient := f.String("recipient", "", "age public recipient")
	urlFile := f.String("database-url-file", "", "local database credential file")
	image := f.String("image", "", "immutable API/Worker image digest")
	configFile := f.String("config-manifest", "", "JSON map of non-secret configuration and file digests")
	actor := f.String("actor", "", "accountable administrator")
	reason := f.String("reason", "", "operation reason")
	incident := f.String("incident-at", "", "RFC3339 incident time for measured RPO")
	isolated := f.Bool("isolated", false, "target is a new isolated database with no runtime access")
	item := f.String("item", "", "recovery item id")
	project := f.String("project", "", "project for handoff or cleanup")
	execute := f.Bool("execute", false, "execute expired-key cleanup; default is preview")
	if err := f.Parse(os.Args[2:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected arguments")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if action == "keygen" {
		key, err := age.GenerateX25519Identity()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(*identity, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		defer out.Close()
		if _, err = fmt.Fprintln(out, key.String()); err != nil {
			return err
		}
		if err = out.Sync(); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]string{"recipient": key.Recipient().String()})
	}
	if action == "verify-backup" {
		temp, err := os.MkdirTemp("", "accp-verify-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(temp)
		m, _, err := recovery.Open(*input, *identity, temp)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(m)
	}
	raw, err := os.ReadFile(*urlFile)
	if err != nil {
		return errors.New("database credential file unavailable")
	}
	url := strings.TrimSpace(string(raw))
	switch action {
	case "diagnostics", "audit-export", "cleanup":
		return recovery.Handoff(ctx, url, action, *output, *actor, *project, *reason, *execute)
	case "resolve-recovery":
		return recovery.Resolve(ctx, url, *item, *actor, *reason)
	case "finish-recovery":
		return recovery.Finish(ctx, url, *actor, *reason)
	case "backup":
		raw, err = os.ReadFile(*configFile)
		if err != nil {
			return errors.New("configuration manifest unavailable")
		}
		var config map[string]string
		if len(raw) > 65536 || json.Unmarshal(raw, &config) != nil || len(config) == 0 {
			return errors.New("bounded public configuration manifest required")
		}
		m, err := recovery.Backup(ctx, url, *recipient, *output, *image, config)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(m)
	case "restore":
		if !*isolated {
			return errors.New("restore requires explicit isolated target")
		}
		at, err := time.Parse(time.RFC3339, *incident)
		if err != nil {
			return errors.New("valid incident-at is required")
		}
		result, err := recovery.Restore(ctx, url, *input, *identity, *actor, *reason, at)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	default:
		return errors.New("unknown operation")
	}
}

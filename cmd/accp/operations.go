package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/JavaWeh/ACCP/internal/config"
	"github.com/JavaWeh/ACCP/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

func workerReady(ctx context.Context, pool *pgxpool.Pool) error {
	var ready bool
	err := pool.QueryRow(ctx, `SELECT event_at>now()-interval '60 seconds' AND governance_at>now()-interval '60 seconds' FROM worker_health WHERE id='default'`).Scan(&ready)
	if err != nil || !ready {
		return errors.New("worker progress unavailable")
	}
	return nil
}

func healthcheck(args []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if len(args) != 1 {
		return errors.New("usage: accp healthcheck api|worker")
	}
	if args[0] == "api" {
		url := "http://127.0.0.1:8080/readyz"
		req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return errors.New("API is unavailable")
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return errors.New("API is not ready")
		}
		return nil
	}
	if args[0] != "worker" {
		return errors.New("unknown health target")
	}
	pool, err := database.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	if err = database.Ready(ctx, pool); err != nil {
		return errors.New("database is not ready")
	}
	return workerReady(ctx, pool)
}

func doctor(args []string) error {
	flags := flag.NewFlagSet("doctor", flag.ContinueOnError)
	asJSON := flags.Bool("json", false, "emit a redacted JSON report")
	if err := flags.Parse(args); err != nil {
		return err
	}
	type check struct {
		Name string `json:"name"`
		OK   bool   `json:"ok"`
	}
	checks := []check{}
	ok := true
	add := func(name string, err error) {
		checks = append(checks, check{name, err == nil})
		if err != nil {
			ok = false
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cfg, err := config.Load()
	add("configuration", err)
	execution, e := config.LoadExecution()
	add("execution_configuration", e)
	if err == nil {
		if cfg.AuthMode != "oidc" {
			add("production_oidc", errors.New("required"))
		} else {
			_, e = auth.NewOIDC(ctx, cfg.Issuer, cfg.Audience)
			add("oidc_discovery", e)
			// Discovery validation alone does not prove JWKS is reachable.
			var discovery struct {
				JWKS string `json:"jwks_uri"`
			}
			e = doctorJSON(ctx, cfg.Issuer+"/.well-known/openid-configuration", &discovery)
			if e == nil {
				var keys struct {
					Keys []json.RawMessage `json:"keys"`
				}
				e = doctorJSON(ctx, discovery.JWKS, &keys)
				if e == nil && len(keys.Keys) == 0 {
					e = errors.New("empty keys")
				}
			}
			add("oidc_jwks", e)
		}
	}
	pool, e := database.Open(ctx, os.Getenv("DATABASE_URL"))
	add("database", e)
	if e == nil {
		defer pool.Close()
		add("migrations", database.Ready(ctx, pool))
		add("worker_progress", workerReady(ctx, pool))
		var elevated bool
		e = pool.QueryRow(ctx, `SELECT rolsuper OR rolcreaterole OR rolcreatedb OR has_schema_privilege(current_user,current_schema(),'CREATE') OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname=current_schema() AND tableowner=current_user) FROM pg_roles WHERE rolname=current_user`).Scan(&elevated)
		if e == nil && elevated {
			e = errors.New("runtime account has elevated privileges")
		}
		add("runtime_privileges", e)
		var stored string
		e = pool.QueryRow(ctx, `SELECT config_digest FROM worker_health WHERE id='default'`).Scan(&stored)
		if e == nil {
			var digest string
			digest, e = config.RuntimeDigest()
			if e == nil && stored != digest {
				e = errors.New("configuration mismatch")
			}
		}
		add("worker_configuration", e)
	}
	if execution.PublicURL != "" {
		var body any
		add("public_tls_and_api", doctorJSON(ctx, execution.PublicURL+"/readyz", &body))
	}
	nc, e := nats.Connect(execution.NATSURL, nats.Token(execution.NATSToken), nats.Timeout(5*time.Second))
	if e == nil {
		var js nats.JetStreamContext
		js, e = nc.JetStream()
		if e == nil {
			_, e = js.AccountInfo()
		}
		nc.Close()
	}
	add("jetstream", e)
	if *asJSON {
		if e = json.NewEncoder(os.Stdout).Encode(struct {
			OK     bool    `json:"ok"`
			Checks []check `json:"checks"`
		}{ok, checks}); e != nil {
			return e
		}
	} else {
		for _, c := range checks {
			fmt.Fprintf(os.Stdout, "%s: %t\n", c.Name, c.OK)
		}
	}
	if !ok {
		return errors.New("installation checks failed; see redacted report")
	}
	return nil
}

func doctorJSON(ctx context.Context, url string, target any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return errors.New("invalid URL")
	}
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return errors.New("endpoint unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return errors.New("endpoint not ready")
	}
	return json.NewDecoder(http.MaxBytesReader(nil, res.Body, 1024*1024)).Decode(target)
}

// human-status is a local maintenance command, never an HTTP privilege escalation route.
func humanStatus(ctx context.Context, pool *pgxpool.Pool, args []string) error {
	flags := flag.NewFlagSet("human-status", flag.ContinueOnError)
	target := flags.String("user", "", "human ID")
	actor := flags.String("actor", "", "accountable administrator ID")
	reason := flags.String("reason", "", "reason")
	active := flags.Bool("active", false, "restore human access (does not restore Sessions)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *target == "" || *actor == "" || *reason == "" {
		return errors.New("user, actor and reason are required")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var org string
	err = tx.QueryRow(ctx, `SELECT organization_id FROM human_users WHERE id=$1 FOR UPDATE`, *target).Scan(&org)
	if err != nil {
		return errors.New("human unavailable")
	}
	var allowed bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.active AND u.active AND 'ADMIN'=ANY(m.roles))`, org, *actor).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return errors.New("accountable actor must be a current administrator in this enterprise")
	}
	rows, err := tx.Query(ctx, `SELECT p.id FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.id FOR UPDATE OF p`, *target)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !*active {
		var last bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships mine WHERE mine.user_id=$1 AND mine.active AND 'ADMIN'=ANY(mine.roles) AND NOT EXISTS(SELECT 1 FROM memberships other JOIN human_users u ON u.id=other.user_id WHERE other.project_id=mine.project_id AND other.user_id<>$1 AND other.active AND u.active AND 'ADMIN'=ANY(other.roles)))`, *target).Scan(&last)
		if err != nil {
			return err
		}
		if last {
			return errors.New("cannot disable the last active project administrator")
		}
		_, err = tx.Exec(ctx, `UPDATE agent_sessions SET status='REVOKED',version=version+1 WHERE delegated_by_user_id=$1 AND status='ACTIVE'`, *target)
		if err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE human_users SET active=$2 WHERE id=$1`, *target, *active)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO organization_audit(id,organization_id,actor_id,action,resource_id,result,reason,trace_id) VALUES('audit_'||md5(random()::text||clock_timestamp()::text),$1,$2,$3,$4,'SUCCEEDED',$5,'operator_'||md5(random()::text))`, org, *actor, fmt.Sprintf("operator.human_active.%t", *active), *target, *reason)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

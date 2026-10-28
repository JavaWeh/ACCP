//go:build integration

package recovery

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestCheckGrantsMissingAndComplete(t *testing.T) {
	ctx := context.Background()
	url := os.Getenv("ACCP_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("integration tests require ACCP_TEST_DATABASE_URL")
	}
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)

	suffix := fmt.Sprintf("%x", rand.Text()[:12])
	schema := "grants_chk_" + suffix
	role := "grants_role_" + suffix
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	quotedRole := pgx.Identifier{role}.Sanitize()
	relation := schema + ".task_contexts"

	if _, err = db.Exec(ctx, `CREATE SCHEMA `+quotedSchema); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(ctx, `DROP SCHEMA `+quotedSchema+` CASCADE`)
	if _, err = db.Exec(ctx, `CREATE TABLE `+quotedSchema+`.task_contexts(id text PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `CREATE ROLE `+quotedRole); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(ctx, `DROP ROLE `+quotedRole)

	required := []requiredPrivilege{{role: role, relation: relation, privilege: "DELETE"}}

	err = checkGrants(ctx, url, required)
	if err == nil {
		t.Fatal("expected failure when DELETE is missing")
	}
	msg := err.Error()
	for _, want := range []string{"DELETE", "task_contexts", role, "grants.sql"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("missing-privilege message %q missing %q", msg, want)
		}
	}

	if _, err = db.Exec(ctx, `GRANT DELETE ON `+quotedSchema+`.task_contexts TO `+quotedRole); err != nil {
		t.Fatal(err)
	}
	if err = checkGrants(ctx, url, required); err != nil {
		t.Fatalf("expected pass after GRANT DELETE: %v", err)
	}

	// Column-level UPDATE must match grants.sql UPDATE(id, active) — not table-level UPDATE.
	humans := quotedSchema + `.human_users`
	if _, err = db.Exec(ctx, `CREATE TABLE `+quotedSchema+`.human_users(id text PRIMARY KEY, active boolean NOT NULL DEFAULT true)`); err != nil {
		t.Fatal(err)
	}
	columnRequired := []requiredPrivilege{{role: role, relation: schema + ".human_users", privilege: "UPDATE", column: "active"}}
	if err = checkGrants(ctx, url, columnRequired); err == nil {
		t.Fatal("expected failure when column UPDATE(active) is missing")
	}
	if _, err = db.Exec(ctx, `GRANT UPDATE(id, active) ON `+humans+` TO `+quotedRole); err != nil {
		t.Fatal(err)
	}
	if err = checkGrants(ctx, url, columnRequired); err != nil {
		t.Fatalf("expected pass after GRANT UPDATE(id, active): %v", err)
	}
	// Table-level UPDATE must still fail closed when only columns are granted.
	tableRequired := []requiredPrivilege{{role: role, relation: schema + ".human_users", privilege: "UPDATE"}}
	if err = checkGrants(ctx, url, tableRequired); err == nil {
		t.Fatal("expected table-level UPDATE check to fail when only column grants exist")
	}
}

package recovery

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// requiredPrivilege is a runtime ACL that must hold after deploy/production/grants.sql.
// When column is non-empty, verification uses has_column_privilege (matching
// grants.sql column-level GRANTs and deploy/production/check-privileges.sql).
type requiredPrivilege struct {
	role, relation, privilege, column string
}

// requiredPrivileges mirrors deploy/production/grants.sql for the current schema version.
// At minimum this includes DELETE on task_contexts for accp_api (D07 re-select context)
// and column UPDATE(active) on human_users for US-14b account deactivate.
var requiredPrivileges = []requiredPrivilege{
	{role: "accp_api", relation: "accp.task_contexts", privilege: "DELETE"},
	{role: "accp_api", relation: "accp.human_users", privilege: "UPDATE", column: "active"},
}

const grantsFixCommand = "docker compose -f deploy/production/compose.yaml run --rm grants  # applies deploy/production/grants.sql"

// CheckGrants verifies that runtime roles hold privileges required by the current
// schema version. Missing role, missing table, query failure, or missing privilege
// all fail closed with an actionable fix pointing at grants.sql.
func CheckGrants(ctx context.Context, url string) error {
	return checkGrants(ctx, url, requiredPrivileges)
}

func checkGrants(ctx context.Context, url string, required []requiredPrivilege) error {
	if len(required) == 0 {
		return errors.New("no required privileges configured")
	}
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		return errors.New("database unavailable")
	}
	defer db.Close(ctx)
	var missing []string
	for _, p := range required {
		var ok bool
		if p.column != "" {
			err = db.QueryRow(ctx, `SELECT has_column_privilege($1::name,$2::text,$3::text,$4::text)`, p.role, p.relation, p.column, p.privilege).Scan(&ok)
		} else {
			err = db.QueryRow(ctx, `SELECT has_table_privilege($1::name,$2::text,$3::text)`, p.role, p.relation, p.privilege).Scan(&ok)
		}
		if err != nil {
			return fmt.Errorf("cannot verify %s privilege on %s for role %s (%v); re-run %s", privilegeDisplay(p), relationDisplay(p.relation), p.role, err, grantsFixCommand)
		}
		if !ok {
			missing = append(missing, fmt.Sprintf("%s privilege on %s for role %s", privilegeDisplay(p), relationDisplay(p.relation), p.role))
		}
	}
	if len(missing) > 0 {
		return missingPrivilegesError(missing)
	}
	return nil
}

func privilegeDisplay(p requiredPrivilege) string {
	if p.column != "" {
		return fmt.Sprintf("%s(%s)", p.privilege, p.column)
	}
	return p.privilege
}

func missingPrivilegesError(missing []string) error {
	return fmt.Errorf("missing %s; fix: re-run %s", strings.Join(missing, "; "), grantsFixCommand)
}

func relationDisplay(relation string) string {
	if i := strings.LastIndex(relation, "."); i >= 0 {
		return relation[i+1:]
	}
	return relation
}

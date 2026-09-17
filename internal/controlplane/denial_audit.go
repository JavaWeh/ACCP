package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var auditIdentifier = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.:-]{1,127}$`)

// The failed business transaction has rolled back. Persist denial metadata in its own transaction.
func (s *Server) recordDenial(r *http.Request, op operation, trace string, cause error) {
	var p problem
	if !errors.As(cause, &p) || p.status < 400 || p.status >= 500 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	fields := strings.Fields(r.Header.Get("Authorization"))
	if len(fields) != 2 {
		return
	}
	tx, e := s.pool.Begin(ctx)
	if e != nil {
		return
	}
	defer tx.Rollback(ctx)
	var user, org, project, sessionID string
	if strings.HasPrefix(fields[1], "accp_s_") && s.signer != nil {
		sessionID, e = s.signer.SessionID(fields[1])
		if e != nil {
			return
		}
		e = tx.QueryRow(ctx, `SELECT delegated_by_user_id,organization_id,project_id FROM agent_sessions WHERE id=$1`, sessionID).Scan(&user, &org, &project)
	} else if strings.HasPrefix(fields[1], "accp_g_") && s.signer != nil {
		sessionID, e = s.signer.Open("gateway:"+strings.TrimSuffix(s.options.PublicURL, "/")+"/mcp", strings.TrimPrefix(fields[1], "accp_g_"))
		if e != nil {
			return
		}
		e = tx.QueryRow(ctx, `SELECT delegated_by_user_id,organization_id,project_id FROM agent_sessions WHERE id=$1`, sessionID).Scan(&user, &org, &project)
	} else if s.auth != nil {
		identity, err := s.auth.Authenticate(ctx, fields[1])
		if err != nil {
			return
		}
		e = tx.QueryRow(ctx, `SELECT id,organization_id FROM human_users WHERE issuer=$1 AND subject=$2`, identity.Issuer, identity.Subject).Scan(&user, &org)
	}
	if e != nil || user == "" {
		return
	}
	if op.organization {
		_, e = tx.Exec(ctx, `INSERT INTO organization_audit(id,organization_id,actor_id,action,resource_id,result,reason,trace_id) VALUES($1,$2,$3,$4,'request','DENIED',$5,$6)`, newID("audit"), org, user, r.Pattern, p.code, trace)
		if e == nil {
			_ = tx.Commit(ctx)
		}
		return
	}
	if project == "" && op.table != "" {
		// Table names come from registered handlers; never from the request.
		var target string
		if op.table == "projects" {
			target = r.PathValue("id")
		} else if safeProjectTable(op.table) {
			_ = tx.QueryRow(ctx, "SELECT project_id FROM "+op.table+" WHERE id=$1 AND organization_id=$2", r.PathValue("id"), org).Scan(&target)
		}
		if target != "" {
			_ = tx.QueryRow(ctx, `SELECT project_id FROM memberships WHERE project_id=$1 AND user_id=$2 AND organization_id=$3`, target, user, org).Scan(&project)
		}
	}
	if project == "" {
		e = tx.QueryRow(ctx, `SELECT project_id FROM memberships WHERE user_id=$1 AND organization_id=$2 ORDER BY project_id LIMIT 1`, user, org).Scan(&project)
		if e != nil {
			return
		}
	}
	kind := "HUMAN"
	var session any
	if sessionID != "" {
		kind = "AGENT"
		session = sessionID
	}
	resource := r.PathValue("id")
	if !auditIdentifier.MatchString(resource) {
		resource = "request"
	}
	details, _ := json.Marshal(Object{"error_code": p.code, "http_status": p.status})
	_, e = tx.Exec(ctx, `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,actor_kind,actor_session_id,action,resource_id,resource_version,trace_id,result,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,'DENIED',$10)`, newID("audit"), project, org, user, kind, session, r.Pattern, resource, trace, details)
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		slog.Warn("denial audit persistence failed", "trace_id", trace)
	}
}

func safeProjectTable(table string) bool {
	switch table {
	case "tasks", "contexts", "context_versions", "context_snapshots", "agents", "agent_sessions", "task_runs", "artifacts", "approvals", "tool_policies", "tool_invocations":
		return true
	}
	return false
}

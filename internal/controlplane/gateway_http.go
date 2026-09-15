package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func gatewayGrant(q *request) (reply, error) {
	p, e := session(q, q.http.PathValue("id"))
	if e != nil {
		return reply{}, e
	}
	if !p.active() || p.Human != q.user || !hasRole(q.roles, "MEMBER") || !slices.Contains(p.Scopes, "tools:invoke") || (q.session != nil && q.session.ID != p.ID) {
		return reply{}, fail(403, "GRANT_DENIED", "A current tool delegation owned by you is required.")
	}
	resource := strings.TrimSuffix(q.server.options.PublicURL, "/") + "/mcp"
	return reply{status: 200, body: Object{"access_token": "accp_g_" + q.server.signer.Seal("gateway:"+resource, p.ID), "token_type": "Bearer", "resource": resource, "expires_at": p.document()["expires_at"]}}, nil
}
func (s *Server) gatewayIdentity(r *http.Request) (*sessionPrincipal, error) {
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.options.PublicURL {
		return nil, fail(403, "ORIGIN_DENIED", "Origin is not allowed.")
	}
	fields := strings.Fields(r.Header.Get("Authorization"))
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || !strings.HasPrefix(fields[1], "accp_g_") || s.signer == nil {
		return nil, fail(401, "GATEWAY_TOKEN_REQUIRED", "Use a token issued for this MCP resource.")
	}
	id, e := s.signer.Open("gateway:"+strings.TrimSuffix(s.options.PublicURL, "/")+"/mcp", strings.TrimPrefix(fields[1], "accp_g_"))
	if e != nil {
		return nil, fail(401, "INVALID_GATEWAY_TOKEN", "Invalid resource audience or credential.")
	}
	tx, e := s.pool.Begin(r.Context())
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(r.Context())
	q := &request{tx: tx, http: r, server: s}
	p, e := session(q, id)
	if e != nil {
		return nil, e
	}
	if !p.active() || !slices.Contains(p.Scopes, "tools:invoke") {
		return nil, fail(401, "SESSION_INACTIVE", "Delegation is no longer valid.")
	}
	var valid bool
	e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND m.active AND u.active AND ('MEMBER'=ANY(m.roles) OR 'ADMIN'=ANY(m.roles)))`, p.Project, p.Human).Scan(&valid)
	if e != nil {
		return nil, e
	}
	if !valid {
		return nil, fail(403, "DELEGATION_REVOKED", "Current human authority no longer permits tools.")
	}
	return p, nil
}

type gatewayInput struct {
	RunID           string         `json:"run_id,omitempty"`
	InvocationID    string         `json:"invocation_id,omitempty"`
	ToolID          string         `json:"tool_id,omitempty"`
	ResourceVersion string         `json:"resource_version,omitempty"`
	Arguments       map[string]any `json:"arguments,omitempty"`
	ArtifactIDs     []string       `json:"artifact_ids,omitempty"`
	IdempotencyKey  string         `json:"idempotency_key,omitempty"`
	Version         int64          `json:"version,omitempty"`
	FencingToken    int64          `json:"fencing_token,omitempty"`
}
type gatewayOutput struct {
	Status int    `json:"status"`
	Body   Object `json:"body"`
}

func (s *Server) mountGateway() {
	s.mux.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, e := s.gatewayIdentity(r)
		if e != nil {
			trace := newID("trace")
			s.recordDenial(r, operation{}, trace, e)
			writeProblem(w, trace, e)
			return
		}
		server := mcp.NewServer(&mcp.Implementation{Name: "accp-mcp-gateway", Version: "0.3.0"}, &mcp.ServerOptions{SupportedProtocolVersions: []string{"2025-11-25"}})
		for _, spec := range []struct{ name, description string }{{"accp_tools", "List the authorized project tool catalog and argument schemas."}, {"accp_tool_request", "Persist a version-bound tool operation. The receipt may require independent human approval. No receipt is proof of external success."}, {"accp_tool_result", "Read the durable operation status and result digest. UNKNOWN requires human reconciliation; do not repeat the operation."}} {
			mcp.AddTool(server, &mcp.Tool{Name: spec.name, Description: spec.description}, func(ctx context.Context, _ *mcp.CallToolRequest, in gatewayInput) (*mcp.CallToolResult, gatewayOutput, error) {
				result, e := s.gatewayCall(ctx, r, p, spec.name, in)
				if e != nil {
					return nil, gatewayOutput{}, e
				}
				return nil, result, nil
			})
		}
		mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true}).ServeHTTP(w, r)
	}))
}
func (s *Server) gatewayCall(ctx context.Context, source *http.Request, p *sessionPrincipal, name string, in gatewayInput) (gatewayOutput, error) {
	method, path := "GET", "/api/v1/projects/"+p.Project+"/tools"
	op := operation{table: "projects", scope: "tools:invoke", run: listResources("tool_policies", "")}
	id := p.Project
	var body Object
	switch name {
	case "accp_tool_request":
		if in.RunID == "" {
			return gatewayOutput{}, errors.New("run_id is required")
		}
		id = in.RunID
		method = "POST"
		path = "/api/v1/task-runs/" + id + "/tool-invocations"
		op = operation{table: "task_runs", scope: "tools:invoke", agentOnly: true, schema: "M3InvocationRequest", conditional: true, fenced: true, run: requestInvocation}
		ids := in.ArtifactIDs
		if ids == nil {
			ids = []string{}
		}
		body = Object{"tool_id": in.ToolID, "resource_version": in.ResourceVersion, "arguments": in.Arguments, "artifact_ids": ids}
	case "accp_tool_result":
		id = in.InvocationID
		path = "/api/v1/tool-invocations/" + id
		op = operation{table: "tool_invocations", scope: "tools:invoke", run: getInvocation}
	}
	data, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, method, "http://gateway"+path, bytes.NewReader(data))
	req.SetPathValue("id", id)
	req.Pattern = method + " /mcp/" + name
	req.Header.Set("Authorization", "Bearer "+s.signer.Token(p.ID))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", in.IdempotencyKey)
	if in.Version > 0 {
		req.Header.Set("If-Match", fmt.Sprintf(`"%d"`, in.Version))
	}
	if in.FencingToken > 0 {
		req.Header.Set("X-Run-Fencing-Token", fmt.Sprint(in.FencingToken))
	}
	trace := newID("trace")
	recorder := httptest.NewRecorder()
	reply, e := s.execute(recorder, req, op, trace)
	if e != nil {
		s.recordDenial(req, op, trace, e)
		var problem problem
		if errors.As(e, &problem) {
			return gatewayOutput{}, fmt.Errorf("%s (trace %s)", problem.code, trace)
		}
		return gatewayOutput{}, fmt.Errorf("operation unavailable (trace %s)", trace)
	}
	encoded, _ := json.Marshal(reply.body)
	var out Object
	_ = json.Unmarshal(encoded, &out)
	return gatewayOutput{Status: reply.status, Body: out}, nil
}

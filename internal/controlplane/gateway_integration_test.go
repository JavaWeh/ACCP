//go:build integration

package controlplane

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/JavaWeh/ACCP/internal/gateway"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type gatewayTestTransport struct{ token string }

func (t gatewayTestTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c := r.Clone(r.Context())
	c.Header = r.Header.Clone()
	c.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(c)
}
func TestM3GatewayResourceAudienceAndRealMCP(t *testing.T) {
	f, _ := setupTools(t)
	_, run, inv := toolIntent(f)
	grant := f.expect(f.call(f.token, "GET", "/agent-sessions/"+f.session+"/gateway-token", "", "", nil), 200, "M3GatewayGrant")
	server := httptest.NewServer(f.server)
	defer server.Close()
	for _, token := range []string{f.token, "invalid"} {
		req, _ := http.NewRequest("POST", server.URL+"/mcp", strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer "+token)
		res, e := server.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		_ = res.Body.Close()
		if res.StatusCode != 401 {
			t.Fatal("MCP accepted wrong resource audience")
		}
	}
	req, _ := http.NewRequest("POST", server.URL+"/mcp", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+textValue(grant, "access_token"))
	req.Header.Set("Origin", "https://untrusted.example")
	res, e := server.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	_ = res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal("MCP accepted untrusted browser origin")
	}
	c := mcp.NewClient(&mcp.Implementation{Name: "gateway-integration", Version: "1"}, nil)
	sess, e := c.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: gatewayTestTransport{textValue(grant, "access_token")}}, MaxRetries: -1, DisableStandaloneSSE: true}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer sess.Close()
	tools, e := sess.ListTools(context.Background(), nil)
	if e != nil || len(tools.Tools) != 3 {
		t.Fatalf("MCP catalog missing %v", e)
	}
	result, e := sess.CallTool(context.Background(), &mcp.CallToolParams{Name: "accp_tool_result", Arguments: Object{"invocation_id": inv["id"]}})
	if e != nil || result.IsError {
		t.Fatalf("MCP receipt failed %v %v", result, e)
	}
	f.expect(f.call(textValue(grant, "access_token"), "GET", "/task-runs/"+textValue(run, "id"), "", "", nil), 401, "")
	current := f.expect(f.call("bob", "GET", "/agent-sessions/"+f.session, "", "", nil), 200, "M2AgentSession")
	f.expect(f.call("bob", "POST", "/agent-sessions/"+f.session+"/revoke", newID("key"), etagOf(current), Object{"reason": "Revoke MCP access"}), 200, "M2AgentSession")
	_, e = sess.ListTools(context.Background(), nil)
	if e == nil {
		t.Fatal("revoked MCP connection kept working")
	}
}
func TestM3UnknownEffectsAreNeverRetried(t *testing.T) {
	f, calls := setupTools(t)
	_, _, inv := toolIntent(f)
	f.server.options.Tools.ExecuteOverride = func(context.Context, *gateway.Backend, map[string]any, string, string) (map[string]any, error) {
		calls.Add(1)
		return nil, errors.New("transport lost after effect")
	}
	f.expect(f.call("alice", "POST", "/approvals/"+textValue(inv, "approval_id")+"/decisions", newID("key"), `"1"`, Object{"decision": "APPROVE", "binding_digest": inv["binding_digest"], "reason": "Approved operation"}), 200, "M3Approval")
	for i := 0; i < 3; i++ {
		if e := f.server.ProcessTools(context.Background()); e != nil {
			t.Fatal(e)
		}
	}
	got := f.expect(f.call("alice", "GET", "/tool-invocations/"+textValue(inv, "id"), "", "", nil), 200, "M3Invocation")
	if got["status"] != "UNKNOWN" || calls.Load() != 1 {
		t.Fatal("uncertain effect was retried")
	}
	f.expect(f.call("alice", "POST", "/tool-invocations/"+textValue(inv, "id")+"/reconcile", newID("key"), etagOf(got), Object{"reason": "Query external state"}), 409, "")
}
func TestM4StaticConsoleAndSecurityHeaders(t *testing.T) {
	f := setupExecution(t)
	f.server.options.WebDirectory = t.TempDir()
	// An absent build must fail with a real 404, never claim the UI is running.
	rec := httptest.NewRecorder()
	f.server.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 404 {
		t.Fatal("missing console assets reported success")
	}
	rec = httptest.NewRecorder()
	f.server.ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/auth/config", nil))
	b, _ := io.ReadAll(rec.Result().Body)
	if rec.Code != 200 || strings.Contains(string(b), f.token) {
		t.Fatal("public auth configuration leaked a credential")
	}
}

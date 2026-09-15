package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type downstreamInput struct {
	Arguments       map[string]any `json:"arguments"`
	OperationID     string         `json:"operation_id"`
	ResourceID      string         `json:"resource_id"`
	ResourceVersion string         `json:"resource_version"`
}

func TestMCPDownstreamUsesSeparateCredentialAndOperationBinding(t *testing.T) {
	t.Setenv("ACCP_TEST_TOOL_CREDENTIAL", "downstream-only-test-value")
	calls := 0
	server := mcp.NewServer(&mcp.Implementation{Name: "downstream-test", Version: "1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "change_resource"}, func(_ context.Context, _ *mcp.CallToolRequest, in downstreamInput) (*mcp.CallToolResult, map[string]any, error) {
		calls++
		if in.OperationID != "operation_test" || in.ResourceID != "resource_test" || in.ResourceVersion != "rev1" {
			t.Fatal("lost operation binding")
		}
		return nil, map[string]any{"state": "SUCCEEDED", "observed": in.Arguments["value"]}, nil
	})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer downstream-only-test-value" {
			t.Error("wrong downstream credential")
			http.Error(w, "unauthorized", 401)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	defer httpServer.Close()
	config := []Backend{{ID: "tool_test", ProjectID: "project_test", ResourceID: "resource_test", Kind: "mcp", Version: "1", Endpoint: httpServer.URL, ToolName: "change_resource", CredentialEnv: "ACCP_TEST_TOOL_CREDENTIAL", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}}, "required": []string{"value"}, "additionalProperties": false}}}
	file := filepath.Join(t.TempDir(), "tools.json")
	data, _ := json.Marshal(config)
	if e := os.WriteFile(file, data, 0600); e != nil {
		t.Fatal(e)
	}
	registry, e := Load(file, true)
	if e != nil {
		t.Fatal(e)
	}
	b, e := registry.Get("tool_test", "project_test")
	if e != nil {
		t.Fatal(e)
	}
	args := map[string]any{"value": "content"}
	if e = b.Validate(args); e != nil {
		t.Fatal(e)
	}
	result, e := registry.Execute(context.Background(), b, args, "operation_test", "rev1")
	if e != nil || result["observed"] != "content" || calls != 1 {
		t.Fatalf("MCP result: %v %v %d", result, e, calls)
	}
	if b.Validate(map[string]any{"value": "x", "endpoint": "http://evil"}) == nil {
		t.Fatal("unknown argument accepted")
	}
	original := b.Version
	config[0].ToolName = "different_tool"
	data, _ = json.Marshal(config)
	_ = os.WriteFile(file, data, 0600)
	changed, e := Load(file, true)
	if e != nil {
		t.Fatal(e)
	}
	if changed.Backends["tool_test"].Version == original {
		t.Fatal("configuration changed without invalidating approval binding")
	}
	if _, e = registry.Get("tool_test", "other_project"); e == nil {
		t.Fatal("cross-project tool exposed")
	}
	if _, e = Load(file, false); e == nil {
		t.Fatal("production accepted cleartext endpoint")
	}
}

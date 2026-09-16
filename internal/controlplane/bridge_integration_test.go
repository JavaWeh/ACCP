//go:build integration

package controlplane

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestM2BridgeRealStdioTransport(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	httpServer := httptest.NewServer(f.server)
	defer httpServer.Close()
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	raw, _ := json.Marshal(f.manifest)
	if err := os.WriteFile(manifest, raw, 0600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "accp-bridge")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", binary, "./cmd/accp-bridge")
	build.Dir = filepath.Join("..", "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build Bridge: %v %s", err, output)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, "stdio")
	command.Env = append(os.Environ(), "ACCP_URL="+httpServer.URL, "ACCP_SESSION_TOKEN="+f.token, "ACCP_ADAPTER_MANIFEST="+manifest)
	session, err := mcp.NewClient(&mcp.Implementation{Name: "integration-mcp-client", Version: "test"}, nil).Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil || len(tools.Tools) != 11 {
		t.Fatal("tool negotiation failed", err)
	}
	call := func(name string, input Object) Object {
		t.Helper()
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: input})
		if err != nil {
			t.Fatal(err)
		}
		if result.IsError {
			t.Fatalf("tool %s rejected request", name)
		}
		data, _ := json.Marshal(result.StructuredContent)
		var output Object
		if json.Unmarshal(data, &output) != nil {
			t.Fatal("invalid tool output")
		}
		return output["body"].(map[string]any)
	}
	result := call("accp_task", Object{"id": task["id"]})
	if result["owner_user_id"] != "user_bob" {
		t.Fatal("stdio did not read real Task")
	}
	claim := call("accp_claim", Object{"idempotency_key": newID("key"), "body": Object{"project_id": "project_demo", "task_id": task["id"], "base_revision": strings.Repeat("a", 40)}})
	run := claim["run"].(map[string]any)
	snapshot := call("accp_snapshot", Object{"id": run["context_snapshot_id"]})
	entry := snapshot["entries"].([]any)[0].(map[string]any)
	version := call("accp_context_version", Object{"context_id": entry["context_id"], "context_version_id": entry["context_version_id"]})
	if version["id"] != entry["context_version_id"] || version["content_digest"] != entry["content_digest"] {
		t.Fatal("Bridge resolved a different Context version")
	}
	contentID := strings.TrimPrefix(textValue(version, "content_uri"), "urn:accp:content:")
	content := call("accp_context_content", Object{"id": contentID})
	if content["content_digest"] != entry["content_digest"] || content["content"] != "# Orders\nGET /orders" {
		t.Fatal("Bridge could not read the exact frozen Context bytes")
	}
	cli := exec.CommandContext(ctx, binary, "call", "accp_context_version")
	cli.Env = command.Env
	cliInput, _ := json.Marshal(Object{"context_id": entry["context_id"], "context_version_id": entry["context_version_id"]})
	cli.Stdin = strings.NewReader(string(cliInput))
	cliOutput, err := cli.Output()
	if err != nil {
		t.Fatalf("CLI Context version read: %v", err)
	}
	var cliResult mcp.CallToolResult
	if json.Unmarshal(cliOutput, &cliResult) != nil || cliResult.IsError {
		t.Fatal("CLI did not preserve tool-specific Context version arguments")
	}
	for _, input := range []Object{
		{"context_id": "../contexts", "context_version_id": entry["context_version_id"]},
		{"context_id": entry["context_id"], "context_version_id": "../versions"},
		{"context_id": "ctx_wrong_parent", "context_version_id": entry["context_version_id"]},
	} {
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "accp_context_version", Arguments: input})
		if err == nil && !result.IsError {
			t.Fatal("invalid Context/version reference accepted")
		}
	}
	heartbeat := call("accp_heartbeat", Object{"id": run["id"], "version": run["version"], "fencing_token": run["fencing_token"], "idempotency_key": newID("key"), "body": Object{"observed_at": now()}})
	if heartbeat["run"].(map[string]any)["status"] != "RUNNING" {
		t.Fatal("stdio heartbeat did not renew lease")
	}
}

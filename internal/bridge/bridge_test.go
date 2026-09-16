package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JavaWeh/ACCP/pkg/client"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPLeaseLifecycleAndManualMode(t *testing.T) {
	for _, auto := range []bool{true, false} {
		t.Run(strconv.FormatBool(auto), func(t *testing.T) {
			api := newLeaseAPI()
			api.entered = make(chan struct{}, 10)
			httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				var body client.Object
				_ = json.NewDecoder(req.Body).Decode(&body)
				version, _ := strconv.ParseInt(strings.Trim(req.Header.Get("If-Match"), `"`), 10, 64)
				fence, _ := strconv.ParseInt(req.Header.Get("X-Run-Fencing-Token"), 10, 64)
				res, err := api.Call(req.Context(), req.Method, strings.TrimPrefix(req.URL.Path, "/api/v1"), body, client.WriteOptions{Version: version, FencingToken: fence, IdempotencyKey: req.Header.Get("Idempotency-Key")})
				if err != nil {
					var failure *client.Error
					if !errors.As(err, &failure) {
						t.Error(err)
						w.WriteHeader(500)
						return
					}
					w.WriteHeader(failure.Status)
					_ = json.NewEncoder(w).Encode(client.Object{"code": failure.Code})
					return
				}
				if strings.HasSuffix(req.URL.Path, "/claim") {
					res.Body["heartbeat_interval_seconds"] = 1 // exercise real HTTP and MCP with a short test interval
				}
				w.WriteHeader(res.Status)
				_ = json.NewEncoder(w).Encode(res.Body)
			}))
			defer httpServer.Close()
			c, err := client.New(httpServer.URL, "accp_s_synthetic_test")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			server := New(c)
			if auto {
				server = NewWithAutoHeartbeat(c)
			}
			st, ct := mcp.NewInMemoryTransports()
			ss, err := server.Connect(ctx, st, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer ss.Close()
			cs, err := mcp.NewClient(&mcp.Implementation{Name: "lease-test", Version: "test"}, nil).Connect(ctx, ct, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer cs.Close()
			result, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "accp_claim", Arguments: map[string]any{"idempotency_key": "claim-test-key", "body": map[string]any{"project_id": "project_test", "base_revision": strings.Repeat("a", 40)}}})
			if err != nil || result.IsError {
				t.Fatalf("claim failed: %v %+v", err, result)
			}
			raw, _ := json.Marshal(result.StructuredContent)
			var out Output
			if err := json.Unmarshal(raw, &out); err != nil {
				t.Fatal(err)
			}
			if auto {
				if out.AutoHeartbeat == nil || out.AutoHeartbeat.State != "running" {
					t.Fatalf("missing managed lease status: %s", raw)
				}
				select {
				case <-api.entered:
				case <-ctx.Done():
					t.Fatal("no background heartbeat")
				}
			} else if out.AutoHeartbeat != nil {
				t.Fatal("one-shot mode claimed to renew automatically")
			}
			if err := cs.Close(); err != nil {
				t.Fatal(err)
			}
			_ = ss.Wait()
			// Allow a heartbeat already in flight to settle, then observe more
			// than a full interval after the connection closes.
			time.Sleep(50 * time.Millisecond)
			count := len(api.recorded())
			time.Sleep(time.Second)
			if len(api.recorded()) != count {
				t.Fatal("closed MCP connection continued renewal")
			}
			if !auto && count != 0 {
				t.Fatal("manual mode renewed in the background")
			}
		})
	}
}

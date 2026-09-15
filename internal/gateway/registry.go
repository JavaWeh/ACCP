// Package gateway owns operator-configured tool endpoints and downstream credentials.
package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/JavaWeh/ACCP/internal/gitprovider"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type Backend struct {
	ID            string         `json:"id"`
	ProjectID     string         `json:"project_id"`
	ResourceID    string         `json:"resource_id"`
	Kind          string         `json:"kind"`
	Version       string         `json:"version"`
	Endpoint      string         `json:"endpoint,omitempty"`
	ToolName      string         `json:"tool_name,omitempty"`
	ReconcileTool string         `json:"reconcile_tool,omitempty"`
	CredentialEnv string         `json:"credential_env,omitempty"`
	RepositoryURL string         `json:"repository_url,omitempty"`
	ReadOnly      bool           `json:"read_only"`
	InputSchema   map[string]any `json:"input_schema"`
	validator     *jsonschema.Schema
	credential    string
}
type Registry struct {
	Backends        map[string]*Backend
	GitHub          *gitprovider.GitHub
	ExecuteOverride func(context.Context, *Backend, map[string]any, string, string) (map[string]any, error)
}

func Load(path string, development bool) (*Registry, error) {
	r := &Registry{Backends: map[string]*Backend{}, GitHub: &gitprovider.GitHub{Token: os.Getenv("ACCP_GITHUB_TOKEN")}}
	if path == "" {
		return r, nil
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, errors.New("cannot read tool configuration")
	}
	defer f.Close()
	var entries []Backend
	decoder := json.NewDecoder(io.LimitReader(f, 1024*1024))
	decoder.DisallowUnknownFields()
	if e = decoder.Decode(&entries); e != nil {
		return nil, errors.New("invalid tool configuration")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New("unexpected tool configuration content")
	}
	for _, entry := range entries {
		b := entry
		if b.ID == "" || b.ProjectID == "" || b.ResourceID == "" || b.Version == "" || r.Backends[b.ID] != nil {
			return nil, errors.New("tool IDs, project, resource and version must be explicit and unique")
		}
		if b.Kind == "git.merge" {
			if _, e = gitprovider.Repository(b.RepositoryURL); e != nil {
				return nil, e
			}
			if b.ReadOnly {
				return nil, errors.New("merge cannot be read-only")
			}
		} else if b.Kind == "mcp" {
			u, e := url.Parse(b.Endpoint)
			if e != nil || u.User != nil || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(development && u.Scheme == "http")) {
				return nil, errors.New("MCP endpoint must be an operator-allowed HTTPS URL")
			}
			if b.ToolName == "" {
				return nil, errors.New("downstream tool name required")
			}
		} else {
			return nil, errors.New("unknown backend kind")
		}
		if b.InputSchema["type"] != "object" || b.InputSchema["additionalProperties"] != false {
			return nil, errors.New("tool arguments require a closed object schema")
		}
		compiler := jsonschema.NewCompiler()
		compiler.AssertFormat()
		compiler.UseLoader(denySchemaLoader{})
		id := "https://accp.invalid/tool/" + b.ID
		if e = compiler.AddResource(id, b.InputSchema); e != nil {
			return nil, errors.New("invalid tool argument schema")
		}
		b.validator, e = compiler.Compile(id)
		if e != nil {
			return nil, errors.New("invalid or remote-referencing tool schema")
		}
		if b.CredentialEnv != "" {
			b.credential = os.Getenv(b.CredentialEnv)
			if b.credential == "" {
				return nil, errors.New("configured downstream credential is missing")
			}
		}
		fingerprint, _ := json.Marshal(b)
		b.Version = fmt.Sprintf("%s:%x", b.Version, sha256.Sum256(fingerprint))
		r.Backends[b.ID] = &b
	}
	return r, nil
}

type denySchemaLoader struct{}

func (denySchemaLoader) Load(string) (any, error) {
	return nil, errors.New("remote schema resolution denied")
}
func (r *Registry) Get(id, project string) (*Backend, error) {
	if r == nil {
		return nil, errors.New("tools are not configured")
	}
	b := r.Backends[id]
	if b == nil || b.ProjectID != project {
		return nil, errors.New("tool is not configured for this project")
	}
	return b, nil
}
func (b *Backend) Validate(args map[string]any) error {
	if b.validator == nil {
		return errors.New("tool schema is unavailable")
	}
	if e := b.validator.Validate(args); e != nil {
		return errors.New("arguments do not match the registered tool schema")
	}
	return nil
}

type credentialTransport struct{ token string }

func (t credentialTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	copy := req.Clone(req.Context())
	copy.Header = req.Header.Clone()
	copy.Header.Del("Authorization")
	if t.token != "" {
		copy.Header.Set("Authorization", "Bearer "+t.token)
	}
	return http.DefaultTransport.RoundTrip(copy)
}
func (r *Registry) Execute(ctx context.Context, b *Backend, args map[string]any, operation, resourceVersion string) (map[string]any, error) {
	if r.ExecuteOverride != nil {
		return r.ExecuteOverride(ctx, b, args, operation, resourceVersion)
	}
	if b.Kind == "git.merge" {
		n, _ := args["pull_request"].(float64)
		sha, _ := args["commit_sha"].(string)
		return r.GitHub.Merge(ctx, b.RepositoryURL, int(n), sha)
	}
	return downstream(ctx, b, b.ToolName, args, operation, resourceVersion)
}
func (r *Registry) Reconcile(ctx context.Context, b *Backend, args map[string]any, operation, resourceVersion string) (map[string]any, error) {
	if b.Kind == "git.merge" {
		n, _ := args["pull_request"].(float64)
		sha, _ := args["commit_sha"].(string)
		return r.GitHub.MergeStatus(ctx, b.RepositoryURL, int(n), sha)
	}
	if b.ReconcileTool == "" {
		return nil, errors.New("this tool has no operation lookup; retain UNKNOWN")
	}
	result, e := downstream(ctx, b, b.ReconcileTool, map[string]any{"operation_id": operation}, operation, resourceVersion)
	if e != nil {
		return nil, e
	}
	state, _ := result["state"].(string)
	if state != "SUCCEEDED" && state != "FAILED" {
		return nil, errors.New("external outcome remains unknown")
	}
	return result, nil
}
func downstream(ctx context.Context, b *Backend, name string, args map[string]any, operation, resourceVersion string) (map[string]any, error) {
	httpClient := &http.Client{Timeout: 12 * time.Second, Transport: credentialTransport{b.credential}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect denied") }}
	c := mcp.NewClient(&mcp.Implementation{Name: "accp-gateway", Version: "0.3.0"}, nil)
	sess, e := c.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: b.Endpoint, HTTPClient: httpClient, MaxRetries: -1, DisableStandaloneSSE: true, MaxEventSize: 262144}, nil)
	if e != nil {
		return nil, errors.New("downstream MCP connection failed")
	}
	defer sess.Close()
	// The downstream contract must enforce these preconditions and preserve the operation ID.
	result, e := sess.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: map[string]any{"arguments": args, "operation_id": operation, "resource_id": b.ResourceID, "resource_version": resourceVersion}})
	if e != nil {
		return nil, errors.New("downstream operation outcome unknown")
	}
	if result.IsError {
		return nil, errors.New("downstream tool reported an error; reconcile before retry")
	}
	data, e := json.Marshal(result.StructuredContent)
	if e != nil || len(data) > 262144 {
		return nil, errors.New("downstream result exceeds limit")
	}
	// Avoid returning credentials accidentally echoed by an upstream service.
	if b.credential != "" && strings.Contains(string(data), b.credential) {
		return nil, errors.New("downstream returned credential material")
	}
	var output map[string]any
	if json.Unmarshal(data, &output) != nil || output == nil {
		return nil, fmt.Errorf("downstream requires bounded structuredContent")
	}
	return output, nil
}

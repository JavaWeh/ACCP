package gitprovider

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestSourcePathIsBoundToRegisteredRepositoryAndBranch(t *testing.T) {
	repo := "https://github.com/example/repo"
	path, err := SourcePath(repo+"/blob/main/docs/spec.md", repo, "main")
	if err != nil || path != "docs/spec.md" {
		t.Fatalf("valid source: %q, %v", path, err)
	}
	for _, raw := range []string{
		"https://github.com/other/repo/blob/main/docs/spec.md",
		"https://github.com/example/repo/blob/dev/docs/spec.md",
		"https://github.com/example/repo/blob/main/../secret",
		"https://github.com/example/repo/blob/main/docs/%2e%2e/secret",
		"https://github.com/example/repo/blob/main/docs/spec.md?ref=evil",
		"https://user@github.com/example/repo/blob/main/docs/spec.md",
	} {
		if _, err := SourcePath(raw, repo, "main"); err == nil {
			t.Fatalf("accepted untrusted source %q", raw)
		}
	}
}

func TestFetchFilePinsCommitAndChecksBytes(t *testing.T) {
	sha := strings.Repeat("a", 40)
	content := "# API\nVersion one\n"
	calls := 0
	provider := &GitHub{Client: &http.Client{Transport: testTransport(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Host != "api.github.com" || req.URL.Path != "/repos/example/repo/contents/docs/spec.md" || req.URL.Query().Get("ref") != sha {
			t.Fatalf("unexpected Git request: %s", req.URL)
		}
		body := fmt.Sprintf(`{"type":"file","encoding":"base64","size":%d,"content":%q}`, len(content), base64.StdEncoding.EncodeToString([]byte(content)))
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	})}}
	got, digest, err := provider.FetchFile(context.Background(), "https://github.com/example/repo", "docs/spec.md", sha)
	if err != nil || got != content || !strings.HasPrefix(digest, "sha256:") || calls != 1 {
		t.Fatalf("import failed: %q %q %v, calls=%d", got, digest, err, calls)
	}
	if _, _, err := provider.FetchFile(context.Background(), "https://github.com/example/repo", "docs/spec.md", "main"); err == nil || calls != 1 {
		t.Fatal("moving ref reached provider")
	}
}

func TestGitHubLiveFileAtCommit(t *testing.T) {
	sha := os.Getenv("ACCP_TEST_GITHUB_SHA")
	if sha == "" {
		t.Skip("set ACCP_TEST_GITHUB_SHA for a live public repository check")
	}
	content, digest, err := (&GitHub{}).FetchFile(context.Background(), "https://github.com/JavaWeh/ACCP", "README.md", sha)
	if err != nil || !strings.HasPrefix(content, "# ACCP") || !strings.HasPrefix(digest, "sha256:") {
		t.Fatalf("live immutable source failed: %v", err)
	}
}

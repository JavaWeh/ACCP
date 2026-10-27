package gitprovider

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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

// TestGitHubLiveTokenSyncFixture is the US-5 acceptance check: with a real
// server token it reads a text file from the private fixture repository at a
// pinned commit and verifies the content hash; with an invalid token it must
// surface a readable authentication error and write no partial content. It is
// skipped unless ACCP_GITHUB_TOKEN is set so CI without the secret stays green.
func TestGitHubLiveTokenSyncFixture(t *testing.T) {
	token := os.Getenv("ACCP_GITHUB_TOKEN")
	if token == "" {
		t.Skip("set ACCP_GITHUB_TOKEN to run the live US-5 private fixture sync check")
	}
	const (
		repo = "https://github.com/JavaWeh/accp-sync-fixture"
		path = "sample/context.txt"
		sha  = "06d0528b6ed5754a0835c9eb39849a248a90ceeb"
		want = "hello from fixture commit for ACCP US-5\n"
	)
	sum := sha256.Sum256([]byte(want))
	wantDigest := "sha256:" + hex.EncodeToString(sum[:])

	// Scenario 1: real token, pinned commit -> success, matching content hash.
	content, digest, err := (&GitHub{Token: token}).FetchFile(context.Background(), repo, path, sha)
	if err != nil {
		t.Fatalf("live sync with real token failed (expected no 403): %v", err)
	}
	if content != want {
		t.Fatalf("content mismatch: got %q want %q", content, want)
	}
	if digest != wantDigest {
		t.Fatalf("digest mismatch: got %q want %q", digest, wantDigest)
	}

	// Scenario 2: invalid token -> readable auth error, no partial content, no leak.
	content, digest, err = (&GitHub{Token: "invalid-token-for-us5"}).FetchFile(context.Background(), repo, path, sha)
	if err == nil {
		t.Fatal("invalid token unexpectedly succeeded")
	}
	if content != "" || digest != "" {
		t.Fatalf("partial content returned on auth failure: content=%q digest=%q", content, digest)
	}
	if !strings.Contains(strings.ToLower(err.Error()), "authentication") {
		t.Fatalf("auth failure not readable: %v", err)
	}
	if strings.Contains(err.Error(), "invalid-token-for-us5") {
		t.Fatal("error message leaked the token")
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

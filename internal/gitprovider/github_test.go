package gitprovider

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

type testTransport func(*http.Request) (*http.Response, error)

func (f testTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestGitEvidenceChecksRepositoryHeadAndBytes(t *testing.T) {
	sha := strings.Repeat("a", 40)
	diff := "diff --git a/api.go b/api.go\n+orders\n"
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(diff)))
	calls := 0
	g := &GitHub{Token: "test-downstream-credential", Client: &http.Client{Transport: testTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "api.github.com" || r.Header.Get("Authorization") != "Bearer test-downstream-credential" {
			t.Fatal("credential target changed")
		}
		body := diff
		if r.Header.Get("Accept") == "application/vnd.github+json" {
			body = fmt.Sprintf(`{"head":{"sha":%q},"base":{"repo":{"full_name":"example/repo"}},"merged":false}`, sha)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	})}}
	ref := Reference{RepositoryURL: "https://github.com/example/repo", URI: "https://github.com/example/repo/pull/7", Kind: "PULL_REQUEST", Revision: sha, Digest: digest}
	evidence, e := g.Verify(context.Background(), ref)
	if e != nil || evidence.PullRequest != 7 || calls != 3 {
		t.Fatalf("verification failed %v %v %d", evidence, e, calls)
	}
	for _, change := range []string{"digest", "sha", "host", "repo", "number"} {
		t.Run(change, func(t *testing.T) {
			bad := ref
			switch change {
			case "digest":
				bad.Digest = "sha256:" + strings.Repeat("0", 64)
			case "sha":
				bad.Revision = strings.Repeat("b", 40)
			case "host":
				bad.URI = "https://127.0.0.1/private"
			case "repo":
				bad.RepositoryURL = "https://github.com/other/private"
			case "number":
				bad.URI += "/extra"
			}
			if _, e := g.Verify(context.Background(), bad); e == nil {
				t.Fatal("untrusted reference verified")
			}
		})
	}
}
func TestRepositoryRejectsAmbiguousTargets(t *testing.T) {
	for _, raw := range []string{"http://github.com/a/b", "https://github.com.evil/a/b", "https://user@github.com/a/b", "https://github.com/a/b?token=secret", "https://github.com/../b", "https://github.com/a/..", "https://github.com/a/b/c"} {
		if _, e := Repository(raw); e == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
func TestMergeUsesAtomicCommitPreconditionAndNoBlindRetry(t *testing.T) {
	calls := 0
	sha := strings.Repeat("a", 40)
	g := &GitHub{Client: &http.Client{Transport: testTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		b, _ := io.ReadAll(r.Body)
		if r.Method != "PUT" || !strings.Contains(string(b), `"sha":"`+sha+`"`) {
			t.Fatal("missing atomic SHA precondition")
		}
		return &http.Response{StatusCode: 409, Body: io.NopCloser(strings.NewReader(`{"merged":false}`)), Header: http.Header{}}, nil
	})}}
	if _, e := g.Merge(context.Background(), "https://github.com/example/repo", 1, sha); e == nil {
		t.Fatal("changed head merge succeeded")
	}
	if calls != 1 {
		t.Fatal("merge was retried")
	}
}

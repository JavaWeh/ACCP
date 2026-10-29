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

// gitlabStub routes GitLab REST calls to canned responses, asserting the
// read-only token travels only as PRIVATE-TOKEN to the configured host.
func gitlabStub(t *testing.T, token string, bodies map[string]string) *http.Client {
	t.Helper()
	return &http.Client{Transport: testTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "gitlab.com" {
			t.Fatalf("credential target changed to %s", r.URL.Host)
		}
		if token != "" && r.Header.Get("PRIVATE-TOKEN") != token {
			t.Fatal("private token header missing or altered")
		}
		if r.Header.Get("Authorization") != "" {
			t.Fatal("token leaked into Authorization header")
		}
		path := r.URL.EscapedPath()
		for suffix, body := range bodies {
			if strings.HasSuffix(path, suffix) {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
			}
		}
		return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader(`{"message":"404 Not Found"}`)), Header: http.Header{}}, nil
	})}
}

func TestGitLabVerifyMatchesGitHubDigestScheme(t *testing.T) {
	sha := strings.Repeat("a", 40)
	diff := `[{"diff":"@@ -1 +1 @@\n-old\n+new\n","new_path":"api.go"}]`
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(diff)))
	g := &GitLab{Host: "gitlab.com", Token: "glpat-readonly", Client: gitlabStub(t, "glpat-readonly", map[string]string{
		"/repository/commits/" + sha + "/diff": diff,
	})}
	ref := Reference{
		RepositoryURL: "https://gitlab.com/group/repo",
		URI:           "https://gitlab.com/group/repo/-/commit/" + sha,
		Kind:          "COMMIT",
		Revision:      sha,
		Digest:        digest,
	}
	evidence, err := g.Verify(context.Background(), ref)
	if err != nil {
		t.Fatalf("verify failed: %v", err)
	}
	if evidence.ContentDigest != digest {
		t.Fatalf("digest %q does not match the GitHub scheme %q", evidence.ContentDigest, digest)
	}
	for _, change := range []string{"digest", "sha", "host", "repo"} {
		bad := ref
		switch change {
		case "digest":
			bad.Digest = "sha256:" + strings.Repeat("0", 64)
		case "sha":
			bad.Revision = strings.Repeat("b", 40)
		case "host":
			bad.URI = "https://gitlab.example.com/group/repo/-/commit/" + sha
		case "repo":
			bad.URI = "https://gitlab.com/other/repo/-/commit/" + sha
		}
		if _, err := g.Verify(context.Background(), bad); err == nil {
			t.Fatalf("untrusted reference verified (%s)", change)
		}
	}
}

func TestGitLabProbeClassifiesErrors(t *testing.T) {
	sha := strings.Repeat("c", 40)
	diff := `[{"diff":"@@ -1 +1 @@\n+x\n"}]`
	g := &GitLab{Host: "gitlab.com", Token: "glpat-x", Client: gitlabStub(t, "glpat-x", map[string]string{
		"/repository/commits/main":             fmt.Sprintf(`{"id":%q}`, sha),
		"/repository/commits/" + sha + "/diff": diff,
	})}
	digest, resolved, err := g.Probe(context.Background(), "https://gitlab.com/group/repo", "main", "", "")
	if err != nil {
		t.Fatalf("probe failed: %v", err)
	}
	if resolved != sha {
		t.Fatalf("head not resolved: %q", resolved)
	}
	if digest != fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(diff))) {
		t.Fatalf("unexpected digest %q", digest)
	}

	authClient := &http.Client{Transport: testTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader(`{"message":"401 Unauthorized"}`)), Header: http.Header{}}, nil
	})}
	ga := &GitLab{Host: "gitlab.com", Token: "bad", Client: authClient}
	if _, _, err := ga.Probe(context.Background(), "https://gitlab.com/group/repo", "main", "", sha); err == nil {
		t.Fatal("expected AUTH classification")
	} else if pe, ok := err.(*ProbeError); !ok || pe.Code != ProbeAuth {
		t.Fatalf("expected AUTH, got %v", err)
	}

	notFound := &GitLab{Host: "gitlab.com", Token: "x", Client: gitlabStub(t, "x", map[string]string{})}
	if _, _, err := notFound.Probe(context.Background(), "https://gitlab.com/group/repo", "main", "", sha); err == nil {
		t.Fatal("expected NOT_FOUND classification")
	} else if pe, ok := err.(*ProbeError); !ok || pe.Code != ProbeNotFound {
		t.Fatalf("expected NOT_FOUND, got %v", err)
	}
}

func TestGitLabErrorNeverLeaksToken(t *testing.T) {
	g := &GitLab{Host: "gitlab.com", Token: "glpat-super-secret", Client: gitlabStub(t, "glpat-super-secret", map[string]string{})}
	_, _, err := g.Probe(context.Background(), "https://gitlab.com/group/repo", "main", "", strings.Repeat("a", 40))
	if err == nil || strings.Contains(err.Error(), "glpat-super-secret") {
		t.Fatalf("token leaked into error: %v", err)
	}
	if _, verr := g.Verify(context.Background(), Reference{RepositoryURL: "https://gitlab.com/group/repo", URI: "https://gitlab.com/group/repo/-/commit/" + strings.Repeat("a", 40), Kind: "COMMIT", Revision: strings.Repeat("a", 40), Digest: "sha256:" + strings.Repeat("0", 64)}); verr != nil && strings.Contains(verr.Error(), "glpat-super-secret") {
		t.Fatalf("token leaked into verify error: %v", verr)
	}
}

func TestNormalizeGitLabShortPathAndFullURL(t *testing.T) {
	cases := map[string]string{
		"group/repo":                           "https://gitlab.com/group/repo",
		"group/subgroup/repo":                  "https://gitlab.com/group/subgroup/repo",
		"https://gitlab.com/group/repo":        "https://gitlab.com/group/repo",
		"https://gitlab.com/group/repo.git":    "https://gitlab.com/group/repo",
		"https://gitlab.example.com/team/proj": "https://gitlab.example.com/team/proj",
		"  https://gitlab.com/group/repo/  ":   "https://gitlab.com/group/repo",
	}
	for in, want := range cases {
		got, err := NormalizeGitLab(in)
		if err != nil || got != want {
			t.Fatalf("NormalizeGitLab(%q)=%q,%v want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "single", "http://gitlab.com/group/repo", "https://user@gitlab.com/group/repo", "https://gitlab.com/group/repo?x=1", "https://gitlab.com/group/..", "group/.."} {
		if _, err := NormalizeGitLab(bad); err == nil {
			t.Fatalf("NormalizeGitLab accepted %q", bad)
		}
	}
}

func TestGitLabSourcePathValidation(t *testing.T) {
	repo := "https://gitlab.com/group/repo"
	path, err := GitLabSourcePath("https://gitlab.com/group/repo/-/blob/main/docs/guide.md", repo, "main")
	if err != nil || path != "docs/guide.md" {
		t.Fatalf("path=%q err=%v", path, err)
	}
	for _, bad := range []string{
		"https://gitlab.com/group/repo/blob/main/docs/guide.md",    // missing /-/
		"https://gitlab.com/other/repo/-/blob/main/docs/guide.md",  // wrong repo
		"https://gitlab.com/group/repo/-/blob/other/docs/guide.md", // wrong branch
		"https://gitlab.com/group/repo/-/blob/main/../secret",      // traversal
	} {
		if _, err := GitLabSourcePath(bad, repo, "main"); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

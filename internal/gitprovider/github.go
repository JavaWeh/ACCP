// Package gitprovider isolates repository hosting from the collaboration domain.
package gitprovider

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Reference struct{ RepositoryURL, URI, Kind, Revision, Digest string }
type Evidence struct {
	Revision      string `json:"revision"`
	ContentDigest string `json:"content_digest"`
	RepositoryURL string `json:"repository_url"`
	URI           string `json:"uri"`
	VerifiedAt    string `json:"verified_at"`
	PullRequest   int    `json:"pull_request,omitempty"`
	Merged        bool   `json:"merged"`
}
type Provider interface {
	Verify(context.Context, Reference) (Evidence, error)
}
type GitHub struct {
	Token  string
	Client *http.Client
}

var revisionPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var repoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func Repository(raw string) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("unsupported repository URL")
	}
	name := strings.TrimSuffix(strings.TrimSuffix(strings.Trim(u.Path, "/"), ".git"), "/")
	if !repoPattern.MatchString(name) {
		return "", errors.New("invalid repository")
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "." || segment == ".." {
			return "", errors.New("invalid repository segment")
		}
	}
	return name, nil
}
func (g *GitHub) request(ctx context.Context, method, path, accept string, body any) ([]byte, int, error) {
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	req, e := http.NewRequestWithContext(ctx, method, "https://api.github.com/repos/"+path, bytes.NewReader(data))
	if e != nil {
		return nil, 0, e
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "ACCP-GitProvider")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if g.Token != "" {
		req.Header.Set("Authorization", "Bearer "+g.Token)
	}
	client := g.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	copy := *client
	copy.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("redirect denied") }
	res, e := copy.Do(req)
	if e != nil {
		return nil, 0, errors.New("provider request failed")
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 4*1024*1024+1))
	if e != nil || len(b) > 4*1024*1024 {
		return nil, res.StatusCode, errors.New("provider response exceeds limit")
	}
	return b, res.StatusCode, nil
}
func (g *GitHub) pull(ctx context.Context, repo string, n int) (string, bool, error) {
	b, status, e := g.request(ctx, "GET", fmt.Sprintf("%s/pulls/%d", repo, n), "application/vnd.github+json", nil)
	if e != nil || status != 200 {
		return "", false, errors.New("pull request unavailable")
	}
	var p struct {
		Head struct{ SHA string }
		Base struct {
			Repo struct {
				FullName string `json:"full_name"`
			}
		}
		Merged bool
	}
	if json.Unmarshal(b, &p) != nil || !strings.EqualFold(p.Base.Repo.FullName, repo) {
		return "", false, errors.New("pull request repository mismatch")
	}
	return p.Head.SHA, p.Merged, nil
}
func (g *GitHub) Verify(ctx context.Context, r Reference) (Evidence, error) {
	repo, e := Repository(r.RepositoryURL)
	if e != nil {
		return Evidence{}, e
	}
	if !revisionPattern.MatchString(r.Revision) {
		return Evidence{}, errors.New("immutable commit SHA required")
	}
	u, e := url.Parse(r.URI)
	if e != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return Evidence{}, errors.New("invalid artifact URI")
	}
	result := Evidence{Revision: r.Revision, RepositoryURL: r.RepositoryURL, URI: r.URI, VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	path := repo + "/commits/" + r.Revision
	switch r.Kind {
	case "COMMIT", "CODE_DIFF":
		if u.Path != "/"+repo+"/commit/"+r.Revision {
			return Evidence{}, errors.New("commit reference mismatch")
		}
	case "PULL_REQUEST":
		prefix := "/" + repo + "/pull/"
		if !strings.HasPrefix(u.Path, prefix) {
			return Evidence{}, errors.New("pull reference mismatch")
		}
		var n int
		suffix := strings.TrimPrefix(u.Path, prefix)
		if _, e = fmt.Sscanf(suffix, "%d", &n); e != nil || n < 1 || fmt.Sprint(n) != suffix {
			return Evidence{}, errors.New("invalid pull number")
		}
		sha, merged, e := g.pull(ctx, repo, n)
		if e != nil || sha != r.Revision {
			return Evidence{}, errors.New("pull head changed")
		}
		result.PullRequest = n
		result.Merged = merged
		path = fmt.Sprintf("%s/pulls/%d", repo, n)
	default:
		return Evidence{}, errors.New("unsupported Git artifact kind")
	}
	b, status, e := g.request(ctx, "GET", path, "application/vnd.github.diff", nil)
	if e != nil || status != 200 {
		return Evidence{}, errors.New("Git diff unavailable")
	}
	sum := sha256.Sum256(b)
	result.ContentDigest = "sha256:" + hex.EncodeToString(sum[:])
	if result.ContentDigest != r.Digest {
		return Evidence{}, errors.New("Git diff digest mismatch")
	}
	if result.PullRequest > 0 {
		sha, _, e := g.pull(ctx, repo, result.PullRequest)
		if e != nil || sha != r.Revision {
			return Evidence{}, errors.New("pull head changed during verification")
		}
	}
	return result, nil
}

// Merge always uses GitHub's atomic head-SHA precondition. Unknown transport outcomes must be reconciled.
func (g *GitHub) Merge(ctx context.Context, repository string, number int, sha string) (map[string]any, error) {
	repo, e := Repository(repository)
	if e != nil || number < 1 || !revisionPattern.MatchString(sha) {
		return nil, errors.New("invalid merge target")
	}
	b, status, e := g.request(ctx, "PUT", fmt.Sprintf("%s/pulls/%d/merge", repo, number), "application/vnd.github+json", map[string]any{"sha": sha, "merge_method": "squash"})
	if e != nil {
		return nil, e
	}
	var result map[string]any
	if json.Unmarshal(b, &result) != nil {
		return nil, errors.New("unknown merge response")
	}
	if status != 200 || result["merged"] != true {
		return nil, fmt.Errorf("merge refused: HTTP %d", status)
	}
	return map[string]any{"merged": true, "commit_sha": result["sha"]}, nil
}
func (g *GitHub) MergeStatus(ctx context.Context, repository string, n int, sha string) (map[string]any, error) {
	repo, e := Repository(repository)
	if e != nil {
		return nil, e
	}
	head, merged, e := g.pull(ctx, repo, n)
	if e != nil {
		return nil, e
	}
	if head != sha {
		return nil, errors.New("pull head changed; cannot reconcile approved commit")
	}
	if !merged {
		return nil, errors.New("merge not confirmed; retain UNKNOWN")
	}
	return map[string]any{"merged": true, "head_sha": head}, nil
}

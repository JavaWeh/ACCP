package gitprovider

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
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
	"unicode/utf8"
)

// GitLab verifies evidence and reads source files from a GitLab instance
// (gitlab.com or a self-hosted host) using a per-repository read-only access
// token. The token is sent only as the PRIVATE-TOKEN header to the configured
// host and never appears in any returned value or error. It produces the same
// "sha256:"+hex content digest scheme as the GitHub provider.
type GitLab struct {
	Host   string // "gitlab.com" or a self-hosted host, e.g. "gitlab.example.com"
	Token  string
	Client *http.Client
}

var gitlabSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)

// GitLabRepository parses a full HTTPS GitLab URL into its host and project
// path. Self-hosted hosts are permitted; the project path may be nested
// (group/subgroup/project). Credentials, queries and fragments are rejected.
func GitLabRepository(raw string) (string, string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", "", errors.New("unsupported repository URL")
	}
	host := strings.ToLower(u.Host)
	if strings.ContainsAny(host, "/@") {
		return "", "", errors.New("unsupported repository host")
	}
	path, err := gitlabPath(u.Path)
	if err != nil {
		return "", "", err
	}
	return host, path, nil
}

func gitlabPath(raw string) (string, error) {
	name := strings.TrimSuffix(strings.Trim(raw, "/"), ".git")
	name = strings.Trim(name, "/")
	if name == "" {
		return "", errors.New("invalid repository path")
	}
	segments := strings.Split(name, "/")
	if len(segments) < 2 || len(name) > 512 {
		return "", errors.New("invalid repository path")
	}
	for _, s := range segments {
		if s == "." || s == ".." || !gitlabSegment.MatchString(s) {
			return "", errors.New("invalid repository segment")
		}
	}
	return name, nil
}

// NormalizeGitLab accepts either a full HTTPS GitLab URL or a short
// group/project path and returns a canonical "https://host/path" URL. A short
// path (no scheme) defaults to the gitlab.com host; a full URL preserves its
// (possibly self-hosted) host.
func NormalizeGitLab(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", errors.New("repository required")
	}
	if !strings.Contains(value, "://") {
		if strings.ContainsAny(value, " \t\r\n") {
			return "", errors.New("invalid repository path")
		}
		path, err := gitlabPath(value)
		if err != nil {
			return "", err
		}
		return "https://gitlab.com/" + path, nil
	}
	host, path, err := GitLabRepository(value)
	if err != nil {
		return "", err
	}
	return "https://" + host + "/" + path, nil
}

func (g *GitLab) base() string {
	host := g.Host
	if host == "" {
		host = "gitlab.com"
	}
	return "https://" + host + "/api/v4"
}

func (g *GitLab) project(repositoryURL string) (string, error) {
	host, path, err := GitLabRepository(repositoryURL)
	if err != nil {
		return "", err
	}
	if g.Host != "" && !strings.EqualFold(host, g.Host) {
		return "", errors.New("repository host mismatch")
	}
	// GitLab identifies a project by its URL-encoded full path.
	return url.QueryEscape(path), nil
}

func (g *GitLab) request(ctx context.Context, path string) ([]byte, int, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", g.base()+path, nil)
	if e != nil {
		return nil, 0, e
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ACCP-GitProvider")
	// A GitLab personal or project access token authenticates read-only calls
	// via PRIVATE-TOKEN; it is only ever sent to the configured host.
	if g.Token != "" {
		req.Header.Set("PRIVATE-TOKEN", g.Token)
	}
	client := g.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	copied := *client
	copied.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("redirect denied") }
	res, e := copied.Do(req)
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

func (g *GitLab) mergeRequest(ctx context.Context, project string, n int) (string, bool, error) {
	b, status, e := g.request(ctx, fmt.Sprintf("/projects/%s/merge_requests/%d", project, n))
	if e != nil || status != 200 {
		return "", false, errors.New("merge request unavailable")
	}
	var m struct {
		SHA      string `json:"sha"`
		State    string `json:"state"`
		DiffRefs struct {
			HeadSHA string `json:"head_sha"`
		} `json:"diff_refs"`
	}
	if json.Unmarshal(b, &m) != nil {
		return "", false, errors.New("merge request parse failed")
	}
	head := m.DiffRefs.HeadSHA
	if head == "" {
		head = m.SHA
	}
	return head, m.State == "merged", nil
}

func (g *GitLab) Verify(ctx context.Context, r Reference) (Evidence, error) {
	project, e := g.project(r.RepositoryURL)
	if e != nil {
		return Evidence{}, e
	}
	if !revisionPattern.MatchString(r.Revision) {
		return Evidence{}, errors.New("immutable commit SHA required")
	}
	host, repoPath, e := GitLabRepository(r.RepositoryURL)
	if e != nil {
		return Evidence{}, e
	}
	u, e := url.Parse(r.URI)
	if e != nil || u.Scheme != "https" || !strings.EqualFold(u.Host, host) || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return Evidence{}, errors.New("invalid artifact URI")
	}
	result := Evidence{Revision: r.Revision, RepositoryURL: r.RepositoryURL, URI: r.URI, VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	var diffPath string
	switch r.Kind {
	case "COMMIT", "CODE_DIFF":
		if u.Path != "/"+repoPath+"/-/commit/"+r.Revision {
			return Evidence{}, errors.New("commit reference mismatch")
		}
		diffPath = "/projects/" + project + "/repository/commits/" + r.Revision + "/diff"
	case "PULL_REQUEST":
		prefix := "/" + repoPath + "/-/merge_requests/"
		if !strings.HasPrefix(u.Path, prefix) {
			return Evidence{}, errors.New("merge request reference mismatch")
		}
		var n int
		suffix := strings.TrimPrefix(u.Path, prefix)
		if _, e = fmt.Sscanf(suffix, "%d", &n); e != nil || n < 1 || fmt.Sprint(n) != suffix {
			return Evidence{}, errors.New("invalid merge request number")
		}
		sha, merged, e := g.mergeRequest(ctx, project, n)
		if e != nil || sha != r.Revision {
			return Evidence{}, errors.New("merge request head changed")
		}
		result.PullRequest = n
		result.Merged = merged
		diffPath = fmt.Sprintf("/projects/%s/merge_requests/%d/diffs", project, n)
	default:
		return Evidence{}, errors.New("unsupported Git artifact kind")
	}
	b, status, e := g.request(ctx, diffPath)
	if e != nil || status != 200 {
		return Evidence{}, errors.New("Git diff unavailable")
	}
	sum := sha256.Sum256(b)
	result.ContentDigest = "sha256:" + hex.EncodeToString(sum[:])
	if result.ContentDigest != r.Digest {
		return Evidence{}, errors.New("Git diff digest mismatch")
	}
	if result.PullRequest > 0 {
		sha, _, e := g.mergeRequest(ctx, project, result.PullRequest)
		if e != nil || sha != r.Revision {
			return Evidence{}, errors.New("merge request head changed during verification")
		}
	}
	return result, nil
}

func (g *GitLab) FetchFile(ctx context.Context, repositoryURL, path, revision string) (string, string, error) {
	project, err := g.project(repositoryURL)
	if err != nil || !revisionPattern.MatchString(revision) {
		return "", "", errors.New("immutable Git commit SHA required")
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\\x00\r\n") {
			return "", "", errors.New("invalid Git file path")
		}
	}
	endpoint := "/projects/" + project + "/repository/files/" + url.QueryEscape(path) + "?ref=" + url.QueryEscape(revision)
	body, status, err := g.request(ctx, endpoint)
	if err != nil {
		return "", "", errors.New("Git file unavailable at the requested commit")
	}
	// Distinguish an authentication/authorization failure from a generic
	// missing file so operators can tell an invalid token apart from a bad
	// path. The HTTP status never contains the token itself.
	if status == 401 || status == 403 {
		return "", "", fmt.Errorf("Git authentication failed (HTTP %d); check the repository access token's read access", status)
	}
	if status != 200 {
		return "", "", errors.New("Git file unavailable at the requested commit")
	}
	var file struct {
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
		Size     int    `json:"size"`
	}
	if json.Unmarshal(body, &file) != nil || file.Encoding != "base64" || file.Size > maxContextBytes {
		return "", "", errors.New("Git source must be a text file of at most 256 KiB")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, file.Content))
	if err != nil || len(decoded) > maxContextBytes || !utf8.Valid(decoded) || bytes.ContainsRune(decoded, 0) {
		return "", "", errors.New("Git source contains invalid or oversized text")
	}
	sum := sha256.Sum256(decoded)
	return string(decoded), "sha256:" + hex.EncodeToString(sum[:]), nil
}

// Probe performs a read-only connectivity check with the repository's stored
// token and returns a content digest in the same scheme as Verify. Failures
// are classified AUTH | NOT_FOUND | NETWORK, never echoing the token.
func (g *GitLab) Probe(ctx context.Context, repositoryURL, defaultBranch, path, revision string) (string, string, error) {
	project, e := g.project(repositoryURL)
	if e != nil {
		return "", "", &ProbeError{ProbeNotFound}
	}
	rev := revision
	if rev == "" {
		branch := defaultBranch
		if branch == "" {
			branch = "HEAD"
		}
		b, status, e := g.request(ctx, "/projects/"+project+"/repository/commits/"+url.QueryEscape(branch))
		if e != nil {
			return "", "", &ProbeError{ProbeNetwork}
		}
		if code := classifyStatus(status); code != "" {
			return "", "", &ProbeError{code}
		}
		var c struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(b, &c) != nil || !revisionPattern.MatchString(c.ID) {
			return "", "", &ProbeError{ProbeNotFound}
		}
		rev = c.ID
	}
	if !revisionPattern.MatchString(rev) {
		return "", "", &ProbeError{ProbeNotFound}
	}
	if path != "" {
		_, digest, e := g.FetchFile(ctx, repositoryURL, path, rev)
		if e != nil {
			return "", "", &ProbeError{ProbeNotFound}
		}
		return digest, rev, nil
	}
	b, status, e := g.request(ctx, "/projects/"+project+"/repository/commits/"+rev+"/diff")
	if e != nil {
		return "", "", &ProbeError{ProbeNetwork}
	}
	if code := classifyStatus(status); code != "" {
		return "", "", &ProbeError{code}
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:]), rev, nil
}

// GitLabSourcePath validates a GitLab blob URL under a registered repository's
// default branch and returns the file path. FetchFile always reads the pinned
// commit SHA instead of the moving branch.
func GitLabSourcePath(raw, repositoryURL, branch string) (string, error) {
	host, repoPath, err := GitLabRepository(repositoryURL)
	if err != nil || branch == "" || strings.ContainsAny(branch, "?#\\") {
		return "", errors.New("unsupported Git source repository")
	}
	u, err := url.Parse(raw)
	prefix := "/" + repoPath + "/-/blob/" + branch + "/"
	if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Host, host) || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, prefix) {
		return "", errors.New("Git source must be a file in the registered repository and default branch")
	}
	path := strings.TrimPrefix(u.Path, prefix)
	if path == "" || strings.ContainsAny(path, "\\\x00\r\n") || len(path) > 1024 {
		return "", errors.New("invalid Git source path")
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", errors.New("invalid Git source path")
		}
	}
	if u.EscapedPath() != (&url.URL{Path: u.Path}).EscapedPath() {
		return "", errors.New("encoded Git source paths are not supported")
	}
	return path, nil
}

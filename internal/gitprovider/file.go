package gitprovider

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"unicode/utf8"
)

const maxContextBytes = 256 * 1024

// FileProvider reads a file from an immutable commit, never from a moving
// branch. Implementations must verify the repository and content bounds.
type FileProvider interface {
	FetchFile(context.Context, string, string, string) (string, string, error)
}

// SourcePath accepts a GitHub document URL under a registered repository's
// default branch. The branch identifies the canonical document location;
// FetchFile always reads the supplied commit SHA instead.
func SourcePath(raw, repositoryURL, branch string) (string, error) {
	repo, err := Repository(repositoryURL)
	if err != nil || branch == "" || strings.ContainsAny(branch, "?#\\") {
		return "", errors.New("unsupported Git source repository")
	}
	u, err := url.Parse(raw)
	prefix := "/" + repo + "/blob/" + branch + "/"
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, prefix) {
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

func (g *GitHub) FetchFile(ctx context.Context, repositoryURL, path, revision string) (string, string, error) {
	repo, err := Repository(repositoryURL)
	if err != nil || !revisionPattern.MatchString(revision) {
		return "", "", errors.New("immutable Git commit SHA required")
	}
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\\x00\r\n") {
			return "", "", errors.New("invalid Git file path")
		}
		parts[i] = url.PathEscape(part)
	}
	body, status, err := g.request(ctx, "GET", repo+"/contents/"+strings.Join(parts, "/")+"?ref="+revision, "application/vnd.github+json", nil)
	if err != nil || status != 200 {
		return "", "", errors.New("Git file unavailable at the requested commit")
	}
	var file struct {
		Type     string `json:"type"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
		Size     int    `json:"size"`
	}
	if json.Unmarshal(body, &file) != nil || file.Type != "file" || file.Encoding != "base64" || file.Size > maxContextBytes {
		return "", "", errors.New("Git source must be a text file of at most 256 KiB")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, file.Content))
	if err != nil || len(decoded) != file.Size || len(decoded) > maxContextBytes || !utf8.Valid(decoded) || strings.ContainsRune(string(decoded), 0) {
		return "", "", errors.New("Git source contains invalid or oversized text")
	}
	sum := sha256.Sum256(decoded)
	return string(decoded), "sha256:" + hex.EncodeToString(sum[:]), nil
}

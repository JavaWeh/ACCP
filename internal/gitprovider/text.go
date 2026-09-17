package gitprovider

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"
)

const MaxTextBytes = 256 * 1024

// TextReader is an optional extension; existing evidence-only providers remain compatible.
type TextReader interface {
	ReadText(context.Context, TextReference) (TextEvidence, error)
}
type TextReference struct{ RepositoryURL, Ref, Path string }
type TextEvidence struct {
	RepositoryURL string `json:"repository_url"`
	Path          string `json:"path"`
	Ref           string `json:"ref"`
	CommitSHA     string `json:"commit_sha"`
	BlobSHA       string `json:"blob_sha"`
	ContentDigest string `json:"content_digest"`
	Content       string `json:"-"`
}

func ValidTextReference(r TextReference) bool {
	if _, err := Repository(r.RepositoryURL); err != nil {
		return false
	}
	if len(r.Path) == 0 || len(r.Path) > 1024 || len(r.Ref) == 0 || len(r.Ref) > 200 || strings.ContainsAny(r.Ref, "\x00\r\n\\?#") || strings.ContainsAny(r.Path, "\x00\r\n\\") || !utf8.ValidString(r.Path) {
		return false
	}
	segments := strings.Split(r.Path, "/")
	if len(segments) > 32 {
		return false
	}
	for _, part := range segments {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func (g *GitHub) ReadText(ctx context.Context, r TextReference) (TextEvidence, error) {
	if !ValidTextReference(r) {
		return TextEvidence{}, errors.New("invalid registered Git text reference")
	}
	repo, _ := Repository(r.RepositoryURL)
	get := func(path string, target any) error {
		raw, status, err := g.request(ctx, "GET", repo+path, "application/vnd.github+json", nil)
		if err != nil || status != 200 {
			return errors.New("Git source unavailable or permission revoked")
		}
		if json.Unmarshal(raw, target) != nil {
			return errors.New("invalid Git source response")
		}
		return nil
	}
	var commit struct {
		SHA    string
		Commit struct{ Tree struct{ SHA string } }
	}
	if err := get("/commits/"+url.PathEscape(r.Ref), &commit); err != nil {
		return TextEvidence{}, err
	}
	if !revisionPattern.MatchString(commit.SHA) || !revisionPattern.MatchString(commit.Commit.Tree.SHA) {
		return TextEvidence{}, errors.New("immutable Git commit and tree required")
	}
	treeSHA := commit.Commit.Tree.SHA
	parts := strings.Split(r.Path, "/")
	blobSHA := ""
	for index, part := range parts {
		var tree struct {
			SHA       string
			Truncated bool
			Tree      []struct {
				Path, Mode, Type, SHA string
				Size                  int64
			}
		}
		if err := get("/git/trees/"+treeSHA, &tree); err != nil {
			return TextEvidence{}, err
		}
		if tree.SHA != treeSHA || tree.Truncated {
			return TextEvidence{}, errors.New("incomplete or mismatched Git tree")
		}
		found := false
		for _, entry := range tree.Tree {
			if entry.Path != part {
				continue
			}
			if found {
				return TextEvidence{}, errors.New("ambiguous Git path")
			}
			found = true
			if !revisionPattern.MatchString(entry.SHA) {
				return TextEvidence{}, errors.New("invalid Git object")
			}
			if index < len(parts)-1 {
				if entry.Type != "tree" || entry.Mode != "040000" {
					return TextEvidence{}, errors.New("Git path must contain only regular directories")
				}
				treeSHA = entry.SHA
			} else {
				if entry.Type != "blob" || (entry.Mode != "100644" && entry.Mode != "100755") || entry.Size < 0 || entry.Size > MaxTextBytes {
					return TextEvidence{}, errors.New("Git source must be a regular text file at most 256 KiB")
				}
				blobSHA = entry.SHA
			}
		}
		if !found {
			return TextEvidence{}, errors.New("Git path not found at resolved commit")
		}
	}
	var blob struct {
		SHA, Encoding, Content string
		Size                   int
	}
	if err := get("/git/blobs/"+blobSHA, &blob); err != nil {
		return TextEvidence{}, err
	}
	if blob.SHA != blobSHA || blob.Encoding != "base64" || blob.Size < 0 || blob.Size > MaxTextBytes || len(blob.Content) > MaxTextBytes*2 {
		return TextEvidence{}, errors.New("invalid or oversized Git blob")
	}
	content, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(blob.Content, "\n", ""))
	if err != nil || len(content) != blob.Size || len(content) > MaxTextBytes || !utf8.Valid(content) || strings.IndexByte(string(content), 0) >= 0 {
		return TextEvidence{}, errors.New("Git source must be bounded UTF-8 text without NUL")
	}
	// SHA-1 is Git's object identity, not an authorization decision; SHA-256 binds stored content.
	hash := sha1.New()
	fmt.Fprintf(hash, "blob %d\x00", len(content))
	hash.Write(content)
	if hex.EncodeToString(hash.Sum(nil)) != blobSHA {
		return TextEvidence{}, errors.New("Git blob bytes do not match object identity")
	}
	digest := sha256.Sum256(content)
	return TextEvidence{RepositoryURL: r.RepositoryURL, Ref: r.Ref, Path: r.Path, CommitSHA: commit.SHA, BlobSHA: blobSHA, ContentDigest: "sha256:" + hex.EncodeToString(digest[:]), Content: string(content)}, nil
}

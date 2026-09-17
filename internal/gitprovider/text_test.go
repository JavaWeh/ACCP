package gitprovider

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestGitTextPinnedObjectsAndRejectedContent(t *testing.T) {
	for _, scenario := range []string{"valid", "moved", "binary", "oversize", "symlink", "truncated", "revoked", "mismatch", "wrong-tree"} {
		t.Run(scenario, func(t *testing.T) {
			content := "# API\n你好\n"
			if scenario == "binary" {
				content = "binary\x00text"
			}
			if scenario == "oversize" {
				content = strings.Repeat("x", MaxTextBytes+1)
			}
			blob := fmt.Sprintf("%x", sha1.Sum([]byte(fmt.Sprintf("blob %d\x00%s", len(content), content))))
			commit, tree := strings.Repeat("a", 40), strings.Repeat("b", 40)
			calls := []string{}
			g := &GitHub{Client: &http.Client{Transport: testTransport(func(r *http.Request) (*http.Response, error) {
				path := r.URL.Path
				calls = append(calls, path)
				status := 200
				var value any
				switch path {
				case "/repos/example/repo/commits/main":
					value = map[string]any{"sha": commit, "commit": map[string]any{"tree": map[string]any{"sha": tree}}}
				case "/repos/example/repo/git/trees/" + tree:
					mode := "100644"
					if scenario == "symlink" {
						mode = "120000"
					}
					sha := tree
					if scenario == "wrong-tree" {
						sha = commit
					}
					value = map[string]any{"sha": sha, "truncated": scenario == "truncated", "tree": []any{map[string]any{"path": "README.md", "mode": mode, "type": "blob", "sha": blob, "size": len(content)}}}
				case "/repos/example/repo/git/blobs/" + blob:
					bytes := content
					if scenario == "mismatch" {
						bytes = strings.ReplaceAll(bytes, "API", "BAD")
					}
					value = map[string]any{"sha": blob, "encoding": "base64", "size": len(bytes), "content": base64.StdEncoding.EncodeToString([]byte(bytes))}
				default:
					t.Fatalf("unpinned or unexpected request %s", path)
				}
				if scenario == "revoked" {
					status = 404
				}
				raw, _ := json.Marshal(value)
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(string(raw))), Header: http.Header{}}, nil
			})}}
			ref := TextReference{RepositoryURL: "https://github.com/example/repo", Ref: "main", Path: "README.md"}
			first, err := g.ReadText(context.Background(), ref)
			if scenario == "valid" || scenario == "moved" {
				if err != nil || first.Content != content || first.CommitSHA != commit || len(calls) != 3 {
					t.Fatalf("%+v %v %v", first, err, calls)
				}
				if scenario == "moved" {
					commit = strings.Repeat("c", 40)
					second, e := g.ReadText(context.Background(), ref)
					if e != nil || second.CommitSHA == first.CommitSHA || second.ContentDigest != first.ContentDigest {
						t.Fatal("mutable ref not re-resolved")
					}
				}
			} else if err == nil {
				t.Fatal("unsafe source accepted")
			}
		})
	}
}

func TestGitTextSourceValidation(t *testing.T) {
	for _, path := range []string{"../secret", "/absolute", "a//b", "a/./b", "a/../b", "a\\b", "a\x00b", strings.Repeat("a/", 33) + "b"} {
		if ValidTextReference(TextReference{"https://github.com/a/b", "main", path}) {
			t.Fatalf("accepted %q", path)
		}
	}
	if ValidTextReference(TextReference{"https://127.0.0.1/private", "main", "README.md"}) {
		t.Fatal("arbitrary target accepted")
	}
}

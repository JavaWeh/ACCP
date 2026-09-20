//go:build integration

package controlplane

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/JavaWeh/ACCP/internal/gitprovider"
	"strings"
	"testing"
)

type gitTextFixture struct {
	content, commit string
	revoked         bool
	calls           int
}

func (g *gitTextFixture) Verify(context.Context, gitprovider.Reference) (gitprovider.Evidence, error) {
	return gitprovider.Evidence{}, errors.New("not used")
}
func (g *gitTextFixture) ReadText(_ context.Context, r gitprovider.TextReference) (gitprovider.TextEvidence, error) {
	g.calls++
	if g.revoked {
		return gitprovider.TextEvidence{}, errors.New("permission revoked")
	}
	return gitprovider.TextEvidence{RepositoryURL: r.RepositoryURL, Path: r.Path, Ref: r.Ref, CommitSHA: g.commit, BlobSHA: strings.Repeat("b", 40), Content: g.content, ContentDigest: fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(g.content)))}, nil
}

func TestGitContextAuthorityDedupeDiffImpactAndPermissions(t *testing.T) {
	f := setupExecution(t)
	provider := &gitTextFixture{content: "original", commit: strings.Repeat("a", 40)}
	f.server.options.GitProvider = provider
	body := Object{"name": "Git API", "type": "API", "repository_id": "repo_demo", "path": "README.md", "ref": "main", "reason": "Register source"}
	for _, actor := range []string{"viewer", f.token} {
		f.expect(f.call(actor, "POST", "/projects/project_demo/git-contexts", newID("key"), "", body), 403, "")
	}
	f.expect(f.call("carol", "POST", "/projects/project_demo/git-contexts", newID("key"), "", body), 404, "")
	bad := Object{}
	for k, v := range body {
		bad[k] = v
	}
	bad["repository_id"] = "repo_secret"
	f.expect(f.call("bob", "POST", "/projects/project_demo/git-contexts", newID("key"), "", bad), 404, "")
	c := f.expect(f.call("bob", "POST", "/projects/project_demo/git-contexts", newID("key"), "", body), 201, "Context")
	path := "/contexts/" + textValue(c, "id")
	v := f.expect(f.call("bob", "POST", path+"/source-sync", "git-sync-key", `"1"`, Object{"reason": "Read source"}), 201, "ContextVersion")
	f.expect(f.call("bob", "POST", path+"/source-sync", "git-sync-key", `"1"`, Object{"reason": "Read source"}), 201, "ContextVersion")
	if provider.calls != 1 {
		t.Fatal("idempotent retry re-read provider")
	}
	provider.commit = strings.Repeat("c", 40)
	duplicate := f.expect(f.call("bob", "POST", path+"/source-sync", newID("key"), `"2"`, Object{"reason": "Ref moved same content"}), 200, "ContextVersion")
	if duplicate["id"] != v["id"] {
		t.Fatal("duplicate content version")
	}
	provider.revoked = true
	f.expect(f.call("bob", "POST", path+"/source-sync", newID("key"), `"2"`, Object{"reason": "Recheck permission"}), 422, "")
	provider.revoked = false
	upload := Object{"source_revision": "fake", "content_uri": v["content_uri"], "content_digest": v["content_digest"], "media_type": v["media_type"], "change_summary": "Bypass Git"}
	f.expect(f.call("bob", "POST", path+"/versions", newID("key"), `"2"`, upload), 409, "")
	f.expect(f.call("bob", "POST", path+"/versions/"+textValue(v, "id")+"/publish", newID("key"), `"1"`, nil), 200, "ContextVersion")
	task := f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", newID("key"), "", taskBody(textValue(v, "id"))), 201, "Task")
	taskPath := "/tasks/" + textValue(task, "id")
	f.expect(f.call("bob", "POST", taskPath+"/assignments", newID("key"), `"1"`, Object{"target": Object{"agent_id": f.agent}}), 201, "M2Assignment")
	task = f.expect(f.call("bob", "POST", taskPath+"/commands", newID("key"), `"2"`, Object{"command": "SUBMIT", "reason": "Run fixed input"}), 200, "Task")
	claim := f.claim(task, newID("key"))
	run := claim["run"].(map[string]any)
	snapshotBefore, _ := json.Marshal(claim["snapshot"])
	provider.content = "updated"
	next := f.expect(f.call("bob", "POST", path+"/source-sync", newID("key"), `"3"`, Object{"reason": "Review update"}), 201, "ContextVersion")
	diff := f.expect(f.call("bob", "GET", path+"/versions/"+textValue(next, "id")+"/diff", "", "", nil), 200, "GitContextDiff")
	if diff["before"] != "original" || diff["after"] != "updated" {
		t.Fatal("wrong published base")
	}
	impact := f.expect(f.call("bob", "GET", path+"/versions/"+textValue(next, "id")+"/impact?limit=25", "", "", nil), 200, "TaskPage")
	if len(impact["items"].([]any)) != 1 {
		t.Fatal("missing affected task")
	}
	f.expect(f.call(f.token, "POST", path+"/source-sync", newID("key"), `"4"`, Object{"reason": "Agent denied"}), 403, "")
	f.expect(f.call("bob", "POST", path+"/versions/"+textValue(next, "id")+"/publish", newID("key"), `"1"`, nil), 200, "ContextVersion")
	after := f.expect(f.call("bob", "GET", "/context-snapshots/"+textValue(run, "context_snapshot_id"), "", "", nil), 200, "M2ContextSnapshot")
	snapshotAfter, _ := json.Marshal(after)
	if string(snapshotBefore) != string(snapshotAfter) {
		t.Fatal("active input overwritten")
	}
	_, other := f.candidate("bob")
	f.expect(f.call("bob", "GET", path+"/versions/"+textValue(next, "id")+"/diff?base="+textValue(other, "id"), "", "", nil), 404, "")
	if _, err := f.pool.Exec(context.Background(), `DELETE FROM context_git_versions`); err == nil {
		t.Fatal("source evidence deleted")
	}
}

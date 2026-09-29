//go:build integration

package controlplane

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/JavaWeh/ACCP/internal/gitprovider"
)

func TestTaskEditTransferArchivePreservesResponsibility(t *testing.T) {
	f := setup(t)
	contextDoc, version := f.candidate("alice")
	f.expect(f.call("bob", "POST", "/contexts/"+textValue(contextDoc, "id")+"/versions/"+textValue(version, "id")+"/publish", "publish-d07", `"1"`, nil), 200, "ContextVersion")
	task := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", "create-d07-task", "", taskBody(textValue(version, "id"))), 201, "Task")
	path := "/tasks/" + textValue(task, "id")
	edit := Object{"title": "Corrected orders", "objective": "Deliver the corrected API", "repository_id": "repo_demo", "acceptance_criteria": []string{"Returns the correct order"}, "context_version_ids": []string{textValue(version, "id")}, "reason": "Clarify acceptance"}
	f.expect(f.call("viewer", "POST", path+"/edit", "viewer-edit-d07", `"1"`, edit), 403, "")
	f.expect(f.call("bob", "POST", path+"/edit", "edit-d07-task", `"1"`, edit), 200, "Task")
	f.expect(f.call("bob", "POST", path+"/transfer", "bad-owner-d07", `"2"`, Object{"owner_user_id": "user_carol", "reason": "Handoff"}), 422, "")
	transferred := f.expect(f.call("bob", "POST", path+"/transfer", "transfer-d07", `"2"`, Object{"owner_user_id": "user_alice", "reason": "Owner changed"}), 200, "Task")
	if transferred["owner_user_id"] != "user_alice" || transferred["status"] != "DRAFT" {
		t.Fatal("transfer did not reset task inputs for resubmission")
	}
	f.expect(f.call("bob", "POST", path+"/edit", "old-owner-edit", `"3"`, edit), 403, "")
	var details []byte
	if err := f.pool.QueryRow(context.Background(), `SELECT details FROM audit_records WHERE resource_id=$1 AND action='task.owner_transfer'`, task["id"]).Scan(&details); err != nil {
		t.Fatal(err)
	}
	var history Object
	_ = json.Unmarshal(details, &history)
	if history["previous_owner_user_id"] != "user_bob" || history["owner_user_id"] != "user_alice" {
		t.Fatal("ownership history incomplete")
	}
	f.expect(f.call("alice", "POST", path+"/commands", "archive-open-d07", `"3"`, Object{"command": "ARCHIVE", "reason": "Archive"}), 409, "")
	f.expect(f.call("alice", "POST", path+"/commands", "cancel-d07", `"3"`, Object{"command": "CANCEL", "reason": "No longer needed"}), 200, "Task")
	f.expect(f.call("alice", "POST", path+"/commands", "archive-d07", `"4"`, Object{"command": "ARCHIVE", "reason": "Close"}), 200, "Task")
	visible := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks", "", "", nil), 200, "")
	if len(visible["items"].([]any)) != 0 {
		t.Fatal("archived task visible in active list")
	}
	archived := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?archived=true", "", "", nil), 200, "")
	if len(archived["items"].([]any)) != 1 {
		t.Fatal("archived task missing from archive filter")
	}
	f.expect(f.call("alice", "POST", path+"/commands", "restore-d07", `"5"`, Object{"command": "RESTORE", "reason": "Reopen archive view"}), 200, "Task")
}

func TestTaskInputRevisionDoesNotRewriteEarlierRun(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	claim := f.claim(task, "claim-before-edit")
	run := claim["run"].(map[string]any)
	path := "/tasks/" + textValue(task, "id")
	current := f.expect(f.call("bob", "GET", path, "", "", nil), 200, "Task")
	edit := Object{"title": "Revised task", "objective": "New requirements", "repository_id": "repo_demo", "acceptance_criteria": []string{"New test"}, "context_version_ids": current["context_version_ids"], "reason": "Updated source"}
	f.expect(f.call("bob", "POST", path+"/edit", "edit-active-run", fmt.Sprintf(`"%d"`, revision(current, "version")), edit), 409, "")
	f.expect(f.runWrite(f.token, run, "/reports", "fail-run-before-edit", Object{"kind": "FAILURE", "error_code": "NEEDS_REVISION", "message": "Input changed"}), 200, "M2TaskRun")
	newContext, newVersion := f.candidate("alice")
	f.expect(f.call("bob", "POST", "/contexts/"+textValue(newContext, "id")+"/versions/"+textValue(newVersion, "id")+"/publish", "publish-new-input", `"1"`, nil), 200, "ContextVersion")
	current = f.expect(f.call("bob", "GET", path, "", "", nil), 200, "Task")
	edit["context_version_ids"] = []string{textValue(newVersion, "id")}
	updated := f.expect(f.call("bob", "POST", path+"/edit", "edit-after-run", fmt.Sprintf(`"%d"`, revision(current, "version")), edit), 200, "Task")
	if updated["status"] != "DRAFT" {
		t.Fatal("revised input was not returned to draft")
	}
	oldSnapshot := f.expect(f.call(f.token, "GET", "/context-snapshots/"+textValue(run, "context_snapshot_id"), "", "", nil), 200, "M2ContextSnapshot")
	oldVersion := oldSnapshot["entries"].([]any)[0].(map[string]any)["context_version_id"]
	if oldVersion == newVersion["id"] {
		t.Fatal("earlier Run snapshot adopted later task input")
	}
	previousRun := f.expect(f.call("bob", "GET", "/task-runs/"+textValue(run, "id"), "", "", nil), 200, "M2TaskRun")
	if previousRun["owner_user_id"] != "user_bob" {
		t.Fatal("earlier Run responsibility changed")
	}
}

type fixtureGitFile struct{ content string }

func (*fixtureGitFile) Verify(context.Context, gitprovider.Reference) (gitprovider.Evidence, error) {
	return gitprovider.Evidence{}, nil
}
func (g *fixtureGitFile) FetchFile(_ context.Context, repository, path, revision string) (string, string, error) {
	if repository != "https://github.com/JavaWeh/ACCP" || path != "docs/spec.md" || len(revision) != 40 {
		return "", "", fail(422, "INVALID_GIT_SOURCE", "Unexpected source")
	}
	return g.content, auth.Digest(g.content), nil
}

func TestGitContextCandidatesRequireReviewAndKeepTaskInput(t *testing.T) {
	f := setup(t)
	provider := &fixtureGitFile{content: "# API\nVersion one\n"}
	f.server.options.GitProvider = provider
	path := "/projects/project_demo/contexts"
	f.expect(f.call("alice", "POST", path, "bad-git-source", "", Object{"name": "Foreign", "type": "API", "source": Object{"kind": "GIT", "canonical_uri": "https://github.com/other/repo/blob/main/docs/spec.md"}}), 422, "")
	contextDoc := f.expect(f.call("alice", "POST", path, "create-git-context", "", Object{"name": "Git API", "type": "API", "source": Object{"kind": "GIT", "canonical_uri": "https://github.com/JavaWeh/ACCP/blob/main/docs/spec.md"}}), 201, "Context")
	base := "/contexts/" + textValue(contextDoc, "id")
	firstSHA := strings.Repeat("a", 40)
	first := f.expect(f.call("alice", "POST", base+"/sync-git", "sync-git-first", `"1"`, Object{"source_revision": firstSHA, "change_summary": "First import"}), 201, "ContextVersion")
	if first["status"] != "CANDIDATE" || first["content_digest"] != auth.Digest(provider.content) {
		t.Fatal("Git file was not stored as a candidate with verified bytes")
	}
	f.expect(f.call("alice", "POST", base+"/sync-git", "sync-git-duplicate", `"2"`, Object{"source_revision": firstSHA, "change_summary": "Duplicate"}), 409, "")
	f.expect(f.call("bob", "POST", base+"/versions/"+textValue(first, "id")+"/publish", "unreviewed-git-first", `"1"`, nil), 409, "")
	f.expect(f.call("bob", "POST", base+"/versions/"+textValue(first, "id")+"/publish-reviewed", "publish-git-first", `"1"`, Object{"reason": "Reviewed source"}), 200, "ContextVersion")
	task := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", "task-git-old", "", taskBody(textValue(first, "id"))), 201, "Task")
	provider.content = "# API\nVersion two\n"
	second := f.expect(f.call("alice", "POST", base+"/sync-git", "sync-git-second", `"3"`, Object{"source_revision": strings.Repeat("b", 40), "change_summary": "Second import"}), 201, "ContextVersion")
	comparison := f.expect(f.call("alice", "GET", base+"/versions/"+textValue(second, "id")+"/comparison", "", "", nil), 200, "")
	if comparison["before_version_id"] != first["id"] || comparison["changed"] != true || number(comparison, "affected_task_count") != 1 {
		t.Fatalf("unexpected comparison: %v", comparison)
	}
	f.expect(f.call("bob", "POST", base+"/versions/"+textValue(second, "id")+"/publish-reviewed", "publish-git-second", `"1"`, Object{"reason": "Compared with prior version"}), 200, "ContextVersion")
	unchanged := f.expect(f.call("alice", "GET", "/tasks/"+textValue(task, "id"), "", "", nil), 200, "Task")
	if unchanged["context_version_ids"].([]any)[0] != first["id"] {
		t.Fatal("publication silently changed an existing task input")
	}
}

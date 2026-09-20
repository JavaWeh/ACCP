//go:build integration

package controlplane

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
)

func TestTaskLifecycleAuthorizationAndHistory(t *testing.T) {
	f := setupExecution(t)
	_, v := f.candidate("bob")
	task := f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", newID("key"), "", taskBody(textValue(v, "id"))), 201, "Task")
	path := "/tasks/" + textValue(task, "id")
	edit := Object{"title": "Revised", "objective": "Revised objective", "acceptance_criteria": []string{"Accepted"}, "reason": "Correct the draft"}
	for _, actor := range []string{"viewer", f.token} {
		f.expect(f.call(actor, "POST", path+"/changes", newID("key"), `"1"`, edit), 403, "")
	}
	f.expect(f.call("carol", "POST", path+"/changes", newID("key"), `"1"`, edit), 404, "")
	task = f.expect(f.call("bob", "POST", path+"/changes", "edit-key", `"1"`, edit), 200, "Task")
	replay := f.expect(f.call("bob", "POST", path+"/changes", "edit-key", `"1"`, edit), 200, "Task")
	if replay["version"] != task["version"] {
		t.Fatal("replay mutated task")
	}
	f.expect(f.call("bob", "POST", path+"/changes", newID("key"), `"1"`, edit), 412, "")
	f.expect(f.call("bob", "POST", path+"/owner-transfers", newID("key"), `"2"`, Object{"owner_user_id": "user_carol", "reason": "Invalid project"}), 422, "")
	f.expect(f.call("bob", "POST", path+"/archive", newID("key"), `"2"`, Object{"reason": "Not ended"}), 409, "")
	f.expect(f.call("bob", "POST", path+"/commands", newID("key"), `"2"`, Object{"command": "CANCEL", "reason": "Stop"}), 200, "Task")
	f.expect(f.call("bob", "POST", path+"/archive", newID("key"), `"3"`, Object{"reason": "Keep history"}), 200, "Task")
	f.expect(f.call("bob", "POST", path+"/commands", newID("key"), `"4"`, Object{"command": "RETRY", "reason": "Archived"}), 409, "")
	f.expect(f.call("bob", "POST", path+"/restore", newID("key"), `"4"`, Object{"reason": "Restore"}), 200, "Task")
	f.expect(f.call("alice", "POST", path+"/owner-transfers", newID("key"), `"5"`, Object{"owner_user_id": "user_alice", "reason": "Admin handover"}), 200, "Task")
	f.expect(f.call("bob", "POST", path+"/owner-transfers", newID("key"), `"6"`, Object{"owner_user_id": "user_bob", "reason": "Old owner denied"}), 403, "")
	changes := f.expect(f.call("alice", "GET", path+"/changes", "", "", nil), 200, "LifecycleChangePage")
	if len(changes["items"].([]any)) != 4 {
		t.Fatal("missing immutable changes")
	}
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_records WHERE resource_id=$1 AND reason<>''`, task["id"]).Scan(&count); err != nil || count < 5 {
		t.Fatalf("audit %d: %v", count, err)
	}
}

func TestTaskTransferAndInputsPreserveRunEvidence(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	claim := f.claim(task, newID("key"))
	run := claim["run"].(map[string]any)
	path := "/tasks/" + textValue(task, "id")
	transfer := Object{"owner_user_id": "user_alice", "reason": "Handover"}
	f.expect(f.call("bob", "POST", path+"/owner-transfers", newID("key"), `"4"`, transfer), 409, "")
	f.expect(f.call("bob", "POST", path+"/commands", newID("key"), `"4"`, Object{"command": "CANCEL", "reason": "Stop before handover"}), 200, "Task")
	f.expect(f.call("bob", "POST", path+"/owner-transfers", newID("key"), `"5"`, transfer), 200, "Task")
	// Build a new input revision from the same immutable Context version.
	body := Object{"title": "New attempt", "objective": "Updated inputs", "acceptance_criteria": []string{"New criteria"}, "repository_id": task["repository_id"], "context_version_ids": task["context_version_ids"], "reason": "Explicit input revision"}
	updated := f.expect(f.call("alice", "POST", path+"/inputs", newID("key"), `"6"`, body), 200, "Task")
	if updated["status"] != "BLOCKED" || number(updated, "input_revision") != 1 {
		t.Fatal("input update did not require retry")
	}
	original := f.expect(f.call("alice", "GET", "/task-runs/"+textValue(run, "id"), "", "", nil), 200, "M2TaskRun")
	if original["owner_user_id"] != run["owner_user_id"] || original["context_snapshot_id"] != run["context_snapshot_id"] {
		t.Fatal("historical responsibility drift")
	}
	snapshot := f.expect(f.call("alice", "GET", "/context-snapshots/"+textValue(run, "context_snapshot_id"), "", "", nil), 200, "M2ContextSnapshot")
	before, _ := json.Marshal(claim["snapshot"])
	after, _ := json.Marshal(snapshot)
	if string(before) != string(after) {
		t.Fatal("snapshot changed")
	}
}

func TestFilteredPaginationBindsQueryAndKeepsLegacy(t *testing.T) {
	f := setupExecution(t)
	_, v := f.candidate("bob")
	for i := 0; i < 4; i++ {
		body := taskBody(textValue(v, "id"))
		body["title"] = fmt.Sprintf("Task %d", i)
		f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 201, "Task")
	}
	base := "/projects/project_demo/tasks?sort=title&archived=false&limit=2"
	first := f.expect(f.call("bob", "GET", base, "", "", nil), 200, "TaskPage")
	cursor := url.QueryEscape(textValue(first, "next_cursor"))
	second := f.expect(f.call("bob", "GET", base+"&cursor="+cursor, "", "", nil), 200, "TaskPage")
	a := first["items"].([]any)
	b := second["items"].([]any)
	if len(a) != 2 || len(b) != 2 || a[1].(map[string]any)["id"] == b[0].(map[string]any)["id"] {
		t.Fatal("unstable page")
	}
	f.expect(f.call("bob", "GET", base+"&owner=user_alice&cursor="+cursor, "", "", nil), 400, "")
	f.expect(f.call("bob", "GET", base+"&cursor="+cursor+"tamper", "", "", nil), 400, "")
	f.expect(f.call("bob", "GET", "/projects/project_demo/tasks?limit=2", "", "", nil), 200, "TaskPage")
}

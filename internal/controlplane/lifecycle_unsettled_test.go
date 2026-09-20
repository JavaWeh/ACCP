//go:build integration

package controlplane

import (
	"context"
	"testing"
)

func TestTaskLifecycleRefusesOutstandingSideEffects(t *testing.T) {
	f, calls := setupTools(t)
	_, run, _ := toolIntent(f)
	path := "/tasks/" + textValue(run, "task_id")
	task := f.expect(f.call("bob", "GET", path, "", "", nil), 200, "Task")
	ended := f.expect(f.call("bob", "POST", path+"/commands", newID("key"), etagOf(task), Object{"command": "CANCEL", "reason": "Stop before handover"}), 200, "Task")
	for _, action := range []string{"archive", "owner-transfers", "inputs"} {
		body := Object{"reason": "Cannot discard outstanding operation"}
		if action == "owner-transfers" {
			body["owner_user_id"] = "user_alice"
		}
		if action == "inputs" {
			for _, key := range []string{"title", "objective", "acceptance_criteria", "repository_id", "context_version_ids"} {
				body[key] = ended[key]
			}
		}
		f.expect(f.call("bob", "POST", path+"/"+action, newID("key"), etagOf(ended), body), 409, "")
	}
	if calls.Load() != 0 {
		t.Fatal("lifecycle retried side effect")
	}
	if err := f.server.ProcessTools(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 {
		t.Fatal("canceled task executed side effect")
	}
}

func TestProjectSummaryPublishedOptionsAndAuditSearch(t *testing.T) {
	f := setupExecution(t)
	c, v := f.candidate("bob")
	task := f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", newID("key"), "", taskBody(textValue(v, "id"))), 201, "Task")
	summary := f.expect(f.call("bob", "GET", "/projects/project_demo/summary", "", "", nil), 200, "")
	if number(summary, "tasks") != 1 {
		t.Fatal("summary is not total")
	}
	options := f.expect(f.call("bob", "GET", "/projects/project_demo/context-version-options?sort=title&limit=25", "", "", nil), 200, "")
	if len(options["items"].([]any)) != 0 {
		t.Fatal("candidate exposed as published input")
	}
	f.expect(f.call("bob", "POST", "/contexts/"+textValue(c, "id")+"/versions/"+textValue(v, "id")+"/publish", newID("key"), `"1"`, nil), 200, "ContextVersion")
	options = f.expect(f.call("bob", "GET", "/projects/project_demo/context-version-options?sort=title&limit=25", "", "", nil), 200, "")
	if len(options["items"].([]any)) != 1 {
		t.Fatal("published input missing")
	}
	audit := f.expect(f.call("alice", "GET", "/projects/project_demo/audit-records?sort=-updated&search="+textValue(task, "id")+"&limit=25", "", "", nil), 200, "")
	if len(audit["items"].([]any)) == 0 {
		t.Fatal("audit search failed")
	}
	f.expect(f.call("viewer", "GET", "/projects/project_demo/audit-records?sort=-updated", "", "", nil), 403, "")
}

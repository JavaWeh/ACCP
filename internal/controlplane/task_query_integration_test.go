//go:build integration

package controlplane

import (
	"net/url"
	"testing"
)

func TestTaskSearchCursorAndWorkbench(t *testing.T) {
	f := setup(t)
	_, version := f.candidate("alice")
	for _, entry := range []struct{ title, owner string }{
		{"Orders alpha", "user_alice"},
		{"Orders beta", "user_bob"},
		{"Payments", "user_bob"},
	} {
		body := taskBody(textValue(version, "id"))
		body["title"] = entry.title
		body["owner_user_id"] = entry.owner
		f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 201, "Task")
	}
	base := "/projects/project_demo/tasks?limit=1&q=Orders"
	first := f.expect(f.call("alice", "GET", base, "", "", nil), 200, "")
	if len(first["items"].([]any)) != 1 || first["next_cursor"] == nil {
		t.Fatal("search did not return a bounded page")
	}
	cursor := url.QueryEscape(textValue(first, "next_cursor"))
	second := f.expect(f.call("alice", "GET", base+"&cursor="+cursor, "", "", nil), 200, "")
	if len(second["items"].([]any)) != 1 || second["next_cursor"] != nil {
		t.Fatal("search continuation returned duplicate or extra rows")
	}
	f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?limit=1&q=Payments&cursor="+cursor, "", "", nil), 400, "")
	owned := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?owner=user_alice", "", "", nil), 200, "")
	if len(owned["items"].([]any)) != 1 {
		t.Fatal("owner filter was ignored")
	}
	f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?updated_after=invalid", "", "", nil), 400, "")
	board := f.expect(f.call("alice", "GET", "/projects/project_demo/workbench", "", "", nil), 200, "")
	if board["mine"] != float64(1) || len(board["recent_tasks"].([]any)) != 3 {
		t.Fatal("workbench summary is inconsistent")
	}
	viewer := f.expect(f.call("viewer", "GET", "/projects/project_demo/workbench", "", "", nil), 200, "")
	if viewer["mine"] != float64(0) || viewer["approvals"] != float64(0) {
		t.Fatal("viewer received another user's workbench")
	}
	f.expect(f.call("alice", "GET", "/projects/project_secret/workbench", "", "", nil), 404, "")
}

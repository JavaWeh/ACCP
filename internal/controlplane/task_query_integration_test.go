//go:build integration

package controlplane

import (
	"context"
	"net/url"
	"sort"
	"testing"
	"time"
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

func TestTaskListSortUpdatedAtDescPaging(t *testing.T) {
	f := setup(t)
	_, version := f.candidate("alice")
	ids := make([]string, 0, 5)
	for i := 0; i < 5; i++ {
		body := taskBody(textValue(version, "id"))
		body["title"] = "Sort " + newID("title")
		task := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 201, "Task")
		ids = append(ids, textValue(task, "id"))
	}
	shared := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	older := time.Date(2026, 3, 14, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	newer := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	stamps := []string{newer, shared, shared, older, older}
	for i, id := range ids {
		if err := setTaskUpdatedAt(f, id, stamps[i]); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	var walked []Object
	path := "/projects/project_demo/tasks?limit=2&sort=updated_at&order=desc"
	for {
		page := f.expect(f.call("alice", "GET", path, "", "", nil), 200, "")
		items := page["items"].([]any)
		if len(items) == 0 {
			t.Fatal("empty page while walking")
		}
		for _, raw := range items {
			item := raw.(map[string]any)
			id := textValue(item, "id")
			if seen[id] {
				t.Fatalf("duplicate id %s", id)
			}
			seen[id] = true
			walked = append(walked, Object(item))
		}
		if page["next_cursor"] == nil {
			break
		}
		path = "/projects/project_demo/tasks?limit=2&sort=updated_at&order=desc&cursor=" + url.QueryEscape(textValue(page, "next_cursor"))
	}
	if len(seen) != len(ids) {
		t.Fatalf("walked %d ids, want %d", len(seen), len(ids))
	}
	for i := 1; i < len(walked); i++ {
		prev, cur := walked[i-1], walked[i]
		prevTS, _ := time.Parse(time.RFC3339Nano, textValue(prev, "updated_at"))
		curTS, _ := time.Parse(time.RFC3339Nano, textValue(cur, "updated_at"))
		if prevTS.Before(curTS) {
			t.Fatalf("updated_at not desc at %d", i)
		}
		if prevTS.Equal(curTS) && textValue(prev, "id") <= textValue(cur, "id") {
			t.Fatalf("id tie-break not desc at %d: %s then %s", i, textValue(prev, "id"), textValue(cur, "id"))
		}
	}
}

func TestTaskListSortCursorRejectedOnSortChange(t *testing.T) {
	f := setup(t)
	_, version := f.candidate("alice")
	for _, title := range []string{"Alpha", "Beta", "Gamma"} {
		body := taskBody(textValue(version, "id"))
		body["title"] = title
		f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 201, "Task")
	}
	first := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?limit=1&sort=title&order=asc", "", "", nil), 200, "")
	cursor := url.QueryEscape(textValue(first, "next_cursor"))
	problem := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?limit=1&sort=updated_at&order=desc&cursor="+cursor, "", "", nil), 400, "")
	if problem["code"] != "INVALID_CURSOR" {
		t.Fatal(problem)
	}
}

func TestTaskListUnsortedPagingStable(t *testing.T) {
	f := setup(t)
	_, version := f.candidate("alice")
	want := map[string]bool{}
	for i := 0; i < 3; i++ {
		body := taskBody(textValue(version, "id"))
		body["title"] = "Unsorted " + newID("t")
		task := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 201, "Task")
		want[textValue(task, "id")] = true
	}
	seen := map[string]bool{}
	path := "/projects/project_demo/tasks?limit=1"
	pages := 0
	for {
		page := f.expect(f.call("alice", "GET", path, "", "", nil), 200, "")
		if _, ok := page["items"]; !ok {
			t.Fatal("missing items")
		}
		if _, ok := page["next_cursor"]; !ok {
			t.Fatal("missing next_cursor key")
		}
		for _, raw := range page["items"].([]any) {
			id := textValue(raw.(map[string]any), "id")
			if seen[id] {
				t.Fatalf("duplicate %s", id)
			}
			seen[id] = true
		}
		pages++
		if page["next_cursor"] == nil {
			break
		}
		path = "/projects/project_demo/tasks?limit=1&cursor=" + url.QueryEscape(textValue(page, "next_cursor"))
	}
	if pages < 2 {
		t.Fatal("expected multi-page unsorted walk")
	}
	for id := range want {
		if !seen[id] {
			t.Fatalf("missing id %s", id)
		}
	}
}

func TestTaskListSortTitleAscAndFilterFingerprint(t *testing.T) {
	f := setup(t)
	_, version := f.candidate("alice")
	for _, title := range []string{"Dup", "Dup", "Zulu", "Alpha"} {
		body := taskBody(textValue(version, "id"))
		body["title"] = title
		f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 201, "Task")
	}
	seen := map[string]bool{}
	var titles []string
	var ids []string
	path := "/projects/project_demo/tasks?limit=2&sort=title&order=asc"
	for {
		page := f.expect(f.call("alice", "GET", path, "", "", nil), 200, "")
		for _, raw := range page["items"].([]any) {
			item := raw.(map[string]any)
			id := textValue(item, "id")
			if seen[id] {
				t.Fatal("duplicate on title sort")
			}
			seen[id] = true
			titles = append(titles, textValue(item, "title"))
			ids = append(ids, id)
		}
		if page["next_cursor"] == nil {
			break
		}
		path = "/projects/project_demo/tasks?limit=2&sort=title&order=asc&cursor=" + url.QueryEscape(textValue(page, "next_cursor"))
	}
	if !sort.StringsAreSorted(titles) {
		t.Fatalf("titles not asc: %v", titles)
	}
	for i := 1; i < len(titles); i++ {
		if titles[i-1] == titles[i] && ids[i-1] >= ids[i] {
			t.Fatalf("equal title tie-break failed: %s >= %s", ids[i-1], ids[i])
		}
	}
	first := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?limit=1&sort=title&order=asc&q=Dup", "", "", nil), 200, "")
	cursor := url.QueryEscape(textValue(first, "next_cursor"))
	problem := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?limit=1&sort=title&order=asc&q=Zulu&cursor="+cursor, "", "", nil), 400, "")
	if problem["code"] != "INVALID_CURSOR" {
		t.Fatal(problem)
	}
	bad := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?sort=created_at", "", "", nil), 400, "")
	if bad["code"] != "INVALID_SORT" {
		t.Fatal(bad)
	}
	orderOnly := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?order=desc", "", "", nil), 400, "")
	if orderOnly["code"] != "INVALID_ORDER" {
		t.Fatal(orderOnly)
	}
	ascPage := f.expect(f.call("alice", "GET", "/projects/project_demo/tasks?limit=2&sort=updated_at&order=asc", "", "", nil), 200, "")
	if len(ascPage["items"].([]any)) == 0 {
		t.Fatal("updated_at asc returned empty")
	}
}

func setTaskUpdatedAt(f *fixture, id, stamp string) error {
	_, err := f.pool.Exec(context.Background(), `UPDATE tasks SET document=jsonb_set(document,'{updated_at}',to_jsonb($1::text)) WHERE id=$2`, stamp, id)
	return err
}

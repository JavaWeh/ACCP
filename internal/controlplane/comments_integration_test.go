//go:build integration

package controlplane

import "testing"

// TestCommentsAreAdvisoryAndNeverChangeTaskState is the KR5 guard: posting,
// editing and deleting comments leaves the task's status and version exactly as
// they were. It also covers the advisory thread end to end — chronological
// listing, author-only edit, soft delete, and the non-member 404.
func TestCommentsAreAdvisoryAndNeverChangeTaskState(t *testing.T) {
	f := setup(t)
	_, v := f.candidate("alice")
	task := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", "c-create", "", taskBody(textValue(v, "id"))), 201, "Task")
	id := textValue(task, "id")
	taskPath := "/tasks/" + id

	before := f.expect(f.call("alice", "GET", taskPath, "", "", nil), 200, "Task")
	wantStatus, wantVersion := textValue(before, "status"), number(before, "version")

	// A plain comment is created and the task is untouched.
	first := f.expect(f.call("alice", "POST", taskPath+"/comments", "c-first-1", "", Object{"body": "Please add an integration test."}), 201, "Comment")
	if first["edited"] != false || first["deleted"] != false {
		t.Fatalf("new comment flags: %v", first)
	}
	assertTaskUnchanged(f, taskPath, wantStatus, wantVersion)

	// A comment mentioning an active member posts and projects a notification,
	// still without changing the task.
	f.expect(f.call("bob", "GET", "/me/notifications/summary", "", "", nil), 200, "")
	f.expect(f.call("alice", "POST", taskPath+"/comments", "c-mention", "", Object{"body": "ping @bob", "mentions": []string{"user_bob"}}), 201, "Comment")
	assertTaskUnchanged(f, taskPath, wantStatus, wantVersion)
	notes := f.expect(f.call("bob", "GET", "/me/notifications", "", "", nil), 200, "")
	items := notes["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("mentioned member received %d notifications, want 1", len(items))
	}
	note := Object(items[0].(map[string]any))
	if textValue(note, "type") != "COMMENT_MENTION" {
		t.Fatalf("notification type: %v", note)
	}
	if textValue(note, "deep_link") != "/projects/project_demo/tasks/"+id+"#comments" {
		t.Fatalf("mention deep link: %v", note)
	}

	// A mention of a user who is not an active member of this project is a 400,
	// the comment is not created, and the task stays put. user_carol is an admin
	// of project_secret only.
	f.expect(f.call("alice", "POST", taskPath+"/comments", "c-badmention", "", Object{"body": "nope", "mentions": []string{"user_carol"}}), 400, "")
	assertTaskUnchanged(f, taskPath, wantStatus, wantVersion)

	// Thread lists oldest-first.
	list := f.expect(f.call("alice", "GET", taskPath+"/comments", "", "", nil), 200, "CommentPage")
	thread := list["items"].([]any)
	if len(thread) != 2 {
		t.Fatalf("thread has %d comments, want 2", len(thread))
	}
	if textValue(Object(thread[0].(map[string]any)), "id") != textValue(first, "id") {
		t.Fatalf("thread is not oldest-first: %v", thread)
	}

	// Only the author may edit; a non-author gets a 404, and the task is untouched.
	f.expect(f.call("bob", "POST", taskPath+"/comments/"+textValue(first, "id")+"/edit", "c-badedit", "", Object{"body": "hijack"}), 404, "")
	edited := f.expect(f.call("alice", "POST", taskPath+"/comments/"+textValue(first, "id")+"/edit", "c-edit-01", "", Object{"body": "Please add an integration test and a unit test."}), 200, "Comment")
	if edited["edited"] != true {
		t.Fatalf("edited flag not set: %v", edited)
	}
	assertTaskUnchanged(f, taskPath, wantStatus, wantVersion)

	// A project ADMIN (alice) can soft-delete any comment; the body is cleared
	// and the tombstone remains, still without touching the task.
	bobComment := f.expect(f.call("bob", "POST", taskPath+"/comments", "c-bob-001", "", Object{"body": "I will take this."}), 201, "Comment")
	deleted := f.expect(f.call("alice", "POST", taskPath+"/comments/"+textValue(bobComment, "id")+"/delete", "c-del-001", "", nil), 200, "Comment")
	if deleted["deleted"] != true || textValue(deleted, "body") != "" {
		t.Fatalf("soft delete did not tombstone: %v", deleted)
	}
	assertTaskUnchanged(f, taskPath, wantStatus, wantVersion)
}

func assertTaskUnchanged(f *fixture, taskPath, status string, version int64) {
	f.t.Helper()
	now := f.expect(f.call("alice", "GET", taskPath, "", "", nil), 200, "Task")
	if textValue(now, "status") != status || number(now, "version") != version {
		f.t.Fatalf("task changed after a comment: status %q v%d, want %q v%d", textValue(now, "status"), number(now, "version"), status, version)
	}
}

// TestCommentsRejectNonMembers confirms a user who is not a member of the task's
// project can neither read nor write its comment thread.
func TestCommentsRejectNonMembers(t *testing.T) {
	f := setup(t)
	_, v := f.candidate("alice")
	task := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", "cn-create", "", taskBody(textValue(v, "id"))), 201, "Task")
	id := textValue(task, "id")
	// carol is not a member of project_demo.
	f.expect(f.call("carol", "GET", "/tasks/"+id+"/comments", "", "", nil), 404, "")
	f.expect(f.call("carol", "POST", "/tasks/"+id+"/comments", "cn-post-1", "", Object{"body": "intruder"}), 404, "")
	f.expect(f.call("", "GET", "/tasks/"+id+"/comments", "", "", nil), 401, "")
}

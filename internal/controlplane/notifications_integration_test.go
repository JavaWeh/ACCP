//go:build integration

package controlplane

import (
	"context"
	"testing"
	"time"
)

// seedNotification inserts one notification row for a project_demo member so the
// read/summary endpoints have deterministic input independent of the event
// projection. read rows carry a read_at equal to their occurred_at.
func seedNotification(f *fixture, id, user, typ, title string, occurredAt time.Time, read bool) {
	f.t.Helper()
	var readAt any
	if read {
		readAt = occurredAt
	}
	_, err := f.pool.Exec(context.Background(),
		`INSERT INTO notifications(id,organization_id,project_id,user_id,type,subject,title,deep_link,occurred_at,read_at)
		 VALUES($1,'org_demo','project_demo',$2,$3,'task_x',$4,'/projects/project_demo/tasks/task_x',$5,$6)`,
		id, user, typ, title, occurredAt, readAt)
	if err != nil {
		f.t.Fatal(err)
	}
}

func TestNotificationsListSummaryAndReadState(t *testing.T) {
	f := setup(t)
	nowTS := time.Now().UTC()
	seedNotification(f, "notif_a", "user_alice", "TASK_ASSIGNED", "Old read", nowTS.Add(-time.Hour), true)
	seedNotification(f, "notif_b", "user_alice", "REVIEW_REQUIRED", "Needs review", nowTS.Add(-30*time.Minute), false)
	seedNotification(f, "notif_c", "user_alice", "TASK_BLOCKED", "Blocked", nowTS.Add(-10*time.Minute), false)
	// Older than the seven-day window: never counted or listed.
	seedNotification(f, "notif_expired", "user_alice", "TASK_ASSIGNED", "Too old", nowTS.Add(-8*24*time.Hour), false)
	// A different recipient's row must never leak across users.
	seedNotification(f, "notif_bob", "user_bob", "TASK_ASSIGNED", "Bob only", nowTS.Add(-5*time.Minute), false)

	summary := f.expect(f.call("alice", "GET", "/me/notifications/summary", "", "", nil), 200, "")
	if number(summary, "unread_count") != 2 {
		t.Fatalf("summary unread_count: got %v, want 2", summary["unread_count"])
	}

	list := f.expect(f.call("alice", "GET", "/me/notifications", "", "", nil), 200, "")
	items := list["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("list returned %d items, want 3 (expired and bob excluded)", len(items))
	}
	first := Object(items[0].(map[string]any))
	if textValue(first, "id") != "notif_c" {
		t.Fatalf("list must be newest-first; first id %q", textValue(first, "id"))
	}
	if textValue(first, "project_name") != "Demo project" {
		t.Fatalf("list item missing project context: %v", first)
	}
	if textValue(first, "deep_link") == "" || first["read"] != false {
		t.Fatalf("list item fields incomplete: %v", first)
	}
	for _, raw := range items {
		if id := textValue(Object(raw.(map[string]any)), "id"); id == "notif_expired" || id == "notif_bob" {
			t.Fatalf("list leaked %q", id)
		}
	}

	unread := f.expect(f.call("alice", "GET", "/me/notifications?unread=true", "", "", nil), 200, "")
	if len(unread["items"].([]any)) != 2 {
		t.Fatalf("unread filter returned %d items, want 2", len(unread["items"].([]any)))
	}

	// One keyset page then its follow-up never repeats or skips a row.
	firstPage := f.expect(f.call("alice", "GET", "/me/notifications?limit=1", "", "", nil), 200, "")
	if len(firstPage["items"].([]any)) != 1 || firstPage["next_cursor"] == nil {
		t.Fatalf("limit=1 must yield one item and a cursor: %v", firstPage)
	}
	cursor := firstPage["next_cursor"].(string)
	secondPage := f.expect(f.call("alice", "GET", "/me/notifications?limit=1&cursor="+cursor, "", "", nil), 200, "")
	if got := textValue(Object(secondPage["items"].([]any)[0].(map[string]any)), "id"); got != "notif_b" {
		t.Fatalf("second page id %q, want notif_b", got)
	}

	// Mark one read; the count drops and a repeat is idempotent.
	read := f.expect(f.call("alice", "POST", "/me/notifications/notif_b/read", "key-b", "", Object{}), 200, "")
	if read["read"] != true || textValue(read, "id") != "notif_b" {
		t.Fatalf("mark-read response: %v", read)
	}
	if n := number(f.expect(f.call("alice", "GET", "/me/notifications/summary", "", "", nil), 200, ""), "unread_count"); n != 1 {
		t.Fatalf("unread_count after read: got %d, want 1", n)
	}
	f.expect(f.call("alice", "POST", "/me/notifications/notif_b/read", "key-b2", "", Object{}), 200, "")

	// One user can neither read nor mutate another's ledger.
	f.expect(f.call("alice", "POST", "/me/notifications/notif_bob/read", "key-foreign", "", Object{}), 404, "")
	f.expect(f.call("alice", "POST", "/me/notifications/does_not_exist/read", "key-missing", "", Object{}), 404, "")
	if n := number(f.expect(f.call("bob", "GET", "/me/notifications/summary", "", "", nil), 200, ""), "unread_count"); n != 1 {
		t.Fatalf("bob should see only his own one unread: got %d", n)
	}

	// Mark all read settles the badge to zero and persists across a read.
	all := f.expect(f.call("alice", "POST", "/me/notifications/read-all", "key-all", "", Object{}), 200, "")
	if number(all, "unread_count") != 0 {
		t.Fatalf("read-all unread_count: got %v, want 0", all["unread_count"])
	}
	if n := number(f.expect(f.call("alice", "GET", "/me/notifications/summary", "", "", nil), 200, ""), "unread_count"); n != 0 {
		t.Fatalf("unread_count after read-all: got %d, want 0", n)
	}
}

// TestNotificationProjectionNotifiesOwner drives a real TASK_ASSIGNED event and
// asserts the task owner receives the projected notification in the same
// transaction, with the correct type and deep link.
func TestNotificationProjectionNotifiesOwner(t *testing.T) {
	f := setup(t)
	_, v := f.candidate("alice")
	task := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", "np-create", "", taskBody(textValue(v, "id"))), 201, "Task")
	id := textValue(task, "id")
	f.expect(f.call("alice", "POST", "/tasks/"+id+"/assignments", "np-assign", `"1"`, Object{"target": Object{"capability_queue": "general"}}), 201, "")

	list := f.expect(f.call("bob", "GET", "/me/notifications", "", "", nil), 200, "")
	items := list["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("owner received %d notifications, want 1", len(items))
	}
	item := Object(items[0].(map[string]any))
	if textValue(item, "type") != "TASK_ASSIGNED" {
		t.Fatalf("notification type: %v", item)
	}
	if textValue(item, "deep_link") != "/projects/project_demo/tasks/"+id {
		t.Fatalf("deep link: %v", item)
	}
	if textValue(item, "title") != "Implement orders" {
		t.Fatalf("notification title should snapshot the task title: %v", item)
	}
}

// TestNotificationProjectionSkipsDeactivatedRecipient is the deactivated-member
// counterexample (US-20 Gherkin): an event whose recipient is no longer an
// active member projects nothing.
func TestNotificationProjectionSkipsDeactivatedRecipient(t *testing.T) {
	f := setup(t)
	_, v := f.candidate("alice")
	task := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", "nd-create", "", taskBody(textValue(v, "id"))), 201, "Task")
	id := textValue(task, "id")
	if _, err := f.pool.Exec(context.Background(), `UPDATE memberships SET active=false WHERE project_id='project_demo' AND user_id='user_bob'`); err != nil {
		t.Fatal(err)
	}
	f.expect(f.call("alice", "POST", "/tasks/"+id+"/assignments", "nd-assign", `"1"`, Object{"target": Object{"capability_queue": "general"}}), 201, "")

	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM notifications WHERE user_id='user_bob'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("deactivated recipient received %d notifications, want 0", count)
	}
}

func TestNotificationsRejectUnauthenticated(t *testing.T) {
	f := setup(t)
	f.expect(f.call("", "GET", "/me/notifications", "", "", nil), 401, "")
	f.expect(f.call("invalid", "GET", "/me/notifications/summary", "", "", nil), 401, "")
}

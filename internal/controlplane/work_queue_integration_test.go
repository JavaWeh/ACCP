//go:build integration

package controlplane

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// createOwnedTask creates a task owned by owner in project_demo and drives its
// document status and updated_at to the supplied values so the my-work
// aggregation has deterministic input.
func createOwnedTask(f *fixture, version, owner, title, status, updatedAt string) string {
	f.t.Helper()
	body := taskBody(version)
	body["title"] = title
	body["owner_user_id"] = owner
	task := f.expect(f.call("alice", "POST", "/projects/project_demo/tasks", newID("key"), "", body), 201, "Task")
	id := textValue(task, "id")
	if err := setTaskStatus(f, id, status); err != nil {
		f.t.Fatal(err)
	}
	if err := setTaskUpdatedAt(f, id, updatedAt); err != nil {
		f.t.Fatal(err)
	}
	return id
}

func setTaskStatus(f *fixture, id, status string) error {
	_, err := f.pool.Exec(context.Background(), `UPDATE tasks SET document=jsonb_set(document,'{status}',to_jsonb($1::text)) WHERE id=$2`, status, id)
	return err
}

func setTaskArchived(f *fixture, id string) error {
	_, err := f.pool.Exec(context.Background(), `UPDATE tasks SET document=jsonb_set(document,'{archived}','true'::jsonb) WHERE id=$1`, id)
	return err
}

// seedSecretTask provisions alice into project_secret and inserts a task she
// owns there, exercising cross-project aggregation and the membership gate.
func seedSecretTask(f *fixture, status, updatedAt string) string {
	f.t.Helper()
	ctx := context.Background()
	_, err := f.pool.Exec(ctx, `INSERT INTO memberships(project_id,organization_id,user_id,roles,active) VALUES('project_secret','org_demo','user_alice',ARRAY['MEMBER'],true)`)
	if err != nil {
		f.t.Fatal(err)
	}
	id := newID("task")
	doc, _ := json.Marshal(Object{"id": id, "title": "Secret work", "status": status, "updated_at": updatedAt, "owner_user_id": "user_alice", "archived": false})
	_, err = f.pool.Exec(ctx, `INSERT INTO tasks(id,project_id,organization_id,owner_user_id,repository_id,document,status) VALUES($1,'project_secret','org_demo','user_alice','repo_secret',$2,'BLOCKED')`, id, doc)
	if err != nil {
		f.t.Fatal(err)
	}
	return id
}

// seedPendingApproval inserts the full invocation chain and a PENDING approval
// in project_demo, tied to taskID so the my-work title resolves through the
// provenance LEFT JOIN. The delegator must be an active member.
func seedPendingApproval(f *fixture, taskID, toolID, createdAt string) string {
	f.t.Helper()
	ctx := context.Background()
	agent := newID("agent")
	sess := newID("session")
	snap := newID("snapshot")
	run := newID("run")
	policy := newID("policy")
	inv := newID("invocation")
	appr := newID("approval")
	future := time.Now().Add(time.Hour)
	exec := func(sql string, args ...any) {
		if _, err := f.pool.Exec(ctx, sql, args...); err != nil {
			f.t.Fatal(err)
		}
	}
	exec(`INSERT INTO agents(id,project_id,organization_id,document,manifest) VALUES($1,'project_demo','org_demo','{}','{}')`, agent)
	exec(`INSERT INTO agent_sessions(id,project_id,organization_id,agent_id,delegated_by_user_id,scopes,expires_at,status) VALUES($1,'project_demo','org_demo',$2,'user_bob',ARRAY['tools:invoke'],$3,'ACTIVE')`, sess, agent, future)
	exec(`INSERT INTO context_snapshots(id,project_id,organization_id,document) VALUES($1,'project_demo','org_demo','{}')`, snap)
	exec(`INSERT INTO task_runs(id,task_id,session_id,snapshot_id,project_id,organization_id,document,status,attempt,fencing_token,lease_expires_at) VALUES($1,$2,$3,$4,'project_demo','org_demo','{}','SUCCEEDED',1,1,$5)`, run, taskID, sess, snap, future)
	exec(`INSERT INTO tool_policies(id,project_id,organization_id,document) VALUES($1,'project_demo','org_demo','{}')`, policy)
	invDoc, _ := json.Marshal(Object{"id": inv, "created_at": createdAt, "status": "AWAITING_APPROVAL", "binding": Object{"tool_id": toolID}, "provenance": Object{"task_id": taskID}})
	exec(`INSERT INTO tool_invocations(id,project_id,organization_id,run_id,session_id,policy_id,document,status,dedupe_key) VALUES($1,'project_demo','org_demo',$2,$3,$4,$5,'AWAITING_APPROVAL',$6)`, inv, run, sess, policy, invDoc, newID("dedupe"))
	apprDoc, _ := json.Marshal(Object{"id": appr, "invocation_id": inv, "status": "PENDING"})
	exec(`INSERT INTO approvals(id,project_id,organization_id,invocation_id,document) VALUES($1,'project_demo','org_demo',$2,$3)`, appr, inv, apprDoc)
	return appr
}

func groupItems(f *fixture, body Object, group string) []any {
	f.t.Helper()
	groups, ok := body["groups"].(map[string]any)
	if !ok {
		f.t.Fatalf("missing groups: %v", body)
	}
	bucket, ok := groups[group].(map[string]any)
	if !ok {
		f.t.Fatalf("missing group %q: %v", group, groups)
	}
	return bucket["items"].([]any)
}

func TestMyWorkAggregatesFiltersAndScopes(t *testing.T) {
	f := setup(t)
	_, version := f.candidate("alice")
	vid := textValue(version, "id")

	createOwnedTask(f, vid, "user_alice", "Review me", "IN_REVIEW", "2026-03-01T00:00:00Z")
	createOwnedTask(f, vid, "user_alice", "Blocked work", "BLOCKED", "2026-03-02T00:00:00Z")
	createOwnedTask(f, vid, "user_alice", "Failed work", "FAILED", "2026-03-03T00:00:00Z")
	createOwnedTask(f, vid, "user_alice", "Still ready", "READY", "2026-03-04T00:00:00Z")
	archived := createOwnedTask(f, vid, "user_alice", "Archived review", "IN_REVIEW", "2026-03-05T00:00:00Z")
	if err := setTaskArchived(f, archived); err != nil {
		t.Fatal(err)
	}
	bobTask := createOwnedTask(f, vid, "user_bob", "Bob review", "IN_REVIEW", "2026-03-06T00:00:00Z")

	seedSecretTask(f, "BLOCKED", "2026-03-07T00:00:00Z")
	seedPendingApproval(f, bobTask, "git.merge", "2026-03-08T00:00:00Z")

	work := f.expect(f.call("alice", "GET", "/me/work", "", "", nil), 200, "WorkQueue")
	review := groupItems(f, work, "review")
	blocked := groupItems(f, work, "blocked")
	approval := groupItems(f, work, "approval")
	if len(review) != 1 {
		t.Fatalf("review group: got %d, want 1", len(review))
	}
	if len(blocked) != 3 {
		t.Fatalf("blocked group: got %d, want 3 (two demo + one secret)", len(blocked))
	}
	if len(approval) != 1 {
		t.Fatalf("approval group: got %d, want 1", len(approval))
	}

	item := review[0].(map[string]any)
	if textValue(Object(item), "title") != "Review me" || textValue(Object(item), "status") != "IN_REVIEW" {
		t.Fatalf("unexpected review item: %v", item)
	}
	if textValue(Object(item), "project_name") != "Demo project" || textValue(Object(item), "waiting_since") == "" {
		t.Fatalf("review item missing project context: %v", item)
	}

	crossProject := false
	for _, raw := range blocked {
		if textValue(Object(raw.(map[string]any)), "project_name") == "Private" {
			crossProject = true
		}
	}
	if !crossProject {
		t.Fatal("blocked group did not aggregate the project_secret item")
	}

	appr := approval[0].(map[string]any)
	if textValue(Object(appr), "title") != "Bob review" {
		t.Fatalf("approval title should resolve to the task title: %v", appr)
	}
	if textValue(Object(appr), "waiting_since") != "2026-03-08T00:00:00Z" {
		t.Fatalf("approval waiting_since should come from the invocation: %v", appr)
	}
	if textValue(Object(appr), "project_name") != "Demo project" {
		t.Fatalf("approval missing project context: %v", appr)
	}

	// bob owns one IN_REVIEW task and is a REVIEWER, so he sees his own review
	// item and the pending approval, but none of alice's work.
	bobWork := f.expect(f.call("bob", "GET", "/me/work", "", "", nil), 200, "WorkQueue")
	if len(groupItems(f, bobWork, "review")) != 1 || len(groupItems(f, bobWork, "blocked")) != 0 {
		t.Fatalf("bob received another member's tasks: %v", bobWork)
	}
	if len(groupItems(f, bobWork, "approval")) != 1 {
		t.Fatalf("bob (REVIEWER) should see the pending approval: %v", bobWork)
	}

	// viewer owns nothing and is not a reviewer anywhere.
	viewerWork := f.expect(f.call("viewer", "GET", "/me/work", "", "", nil), 200, "WorkQueue")
	if len(groupItems(f, viewerWork, "review")) != 0 || len(groupItems(f, viewerWork, "approval")) != 0 {
		t.Fatalf("viewer received work that is not theirs: %v", viewerWork)
	}
}

func TestMyWorkExcludesDeactivatedMembership(t *testing.T) {
	f := setup(t)
	f.candidate("alice")
	seedSecretTask(f, "BLOCKED", "2026-04-01T00:00:00Z")

	before := f.expect(f.call("alice", "GET", "/me/work", "", "", nil), 200, "WorkQueue")
	if len(groupItems(f, before, "blocked")) != 1 {
		t.Fatalf("expected the cross-project item before deactivation: %v", before)
	}

	if _, err := f.pool.Exec(context.Background(), `UPDATE memberships SET active=false WHERE project_id='project_secret' AND user_id='user_alice'`); err != nil {
		t.Fatal(err)
	}
	after := f.expect(f.call("alice", "GET", "/me/work", "", "", nil), 200, "WorkQueue")
	if len(groupItems(f, after, "blocked")) != 0 {
		t.Fatalf("deactivated membership must yield zero items: %v", after)
	}
}

func TestMyWorkRejectsUnauthenticated(t *testing.T) {
	f := setup(t)
	f.expect(f.call("", "GET", "/me/work", "", "", nil), 401, "")
	f.expect(f.call("invalid", "GET", "/me/work", "", "", nil), 401, "")
	// A token with no provisioned active human mapping cannot read work.
	f.expect(f.call("agent", "GET", "/me/work", "", "", nil), 403, "")
}

//go:build integration

package controlplane

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestManagementCreationIsolationAndArchive(t *testing.T) {
	f := setup(t)
	f.server.options.AuthMode = "development"
	f.expect(f.call("bob", "POST", "/projects", "member-cannot-create", "", Object{"name": "Forbidden"}), 403, "")
	body := Object{"name": "New project"}
	p := f.expect(f.call("alice", "POST", "/projects", "stable-project-create", "", body), 201, "ManagementProject")
	replay := f.expect(f.call("alice", "POST", "/projects", "stable-project-create", "", body), 201, "ManagementProject")
	if p["id"] != replay["id"] {
		t.Fatal("duplicate project")
	}
	f.expect(f.call("alice", "POST", "/projects", "stable-project-create", "", Object{"name": "different"}), 409, "")
	path := "/projects/" + textValue(p, "id")
	f.expect(f.call("bob", "GET", path, "", "", nil), 404, "")
	person := f.expect(f.call("alice", "POST", "/organization/members", newID("key"), "", Object{"issuer": "urn:accp:development", "subject": "new-human", "display_name": "New human", "reason": "Onboard"}), 201, "ManagementHuman")
	f.expect(f.call("new-human", "GET", path, "", "", nil), 404, "")
	f.expect(f.call("alice", "POST", path+"/members", newID("key"), "", Object{"user_id": person["id"], "roles": []string{"MEMBER"}, "reason": "Join"}), 201, "Membership")
	f.expect(f.call("new-human", "GET", path, "", "", nil), 200, "ManagementProject")
	repo := Object{"url": "https://github.com/Example/Orders.git", "default_branch": "main", "reason": "Delivery"}
	f.expect(f.call("alice", "POST", path+"/repositories", newID("key"), "", repo), 201, "Repository")
	repo["url"] = "https://github.com/example/orders"
	f.expect(f.call("alice", "POST", path+"/repositories", newID("key"), "", repo), 409, "")
	f.expect(f.call("alice", "POST", path+"/changes", newID("key"), `"9"`, Object{"name": "New name", "reason": "Rename"}), 412, "")
	f.expect(f.call("alice", "POST", path+"/commands", newID("key"), `"1"`, Object{"command": "ARCHIVE", "reason": "Finished"}), 200, "ManagementProject")
	f.expect(f.call("alice", "POST", path+"/repositories", newID("key"), "", repo), 409, "")
	f.expect(f.call("alice", "POST", path+"/commands", newID("key"), `"2"`, Object{"command": "RESTORE", "reason": "Resume"}), 200, "ManagementProject")
	f.expect(f.call("alice", "GET", "/organization/audit-records", "", "", nil), 200, "ManagementAuditPage")
	f.expect(f.call("bob", "GET", "/organization/audit-records", "", "", nil), 403, "")
}

func TestManagementArchiveBlocksWorkAndDisableRevokesSessions(t *testing.T) {
	f := setupExecution(t)
	task := f.readyTask()
	f.claim(task, newID("key"))
	blocked := f.expect(f.call("alice", "POST", "/projects/project_demo/commands", newID("key"), `"1"`, Object{"command": "ARCHIVE", "reason": "Must fail"}), 409, "")
	if blocked["code"] != "ARCHIVE_BLOCKED" {
		t.Fatalf("expected ARCHIVE_BLOCKED, got %v", blocked["code"])
	}
	detail, _ := blocked["detail"].(string)
	if !strings.Contains(detail, "task:") || !strings.Contains(detail, textValue(task, "id")) {
		t.Fatalf("expected blocker task id in detail, got %q", detail)
	}
	f.expect(f.call("alice", "POST", "/projects/project_demo/members/user_bob/changes", newID("key"), `"1"`, Object{"roles": []string{"MEMBER", "REVIEWER"}, "active": false, "reason": "Offboard"}), 200, "Membership")
	f.expect(f.call(f.token, "GET", "/projects/project_demo/tasks", "", "", nil), 401, "")
	f.expect(f.call("alice", "POST", "/projects/project_demo/members/user_bob/changes", newID("key"), `"2"`, Object{"roles": []string{"MEMBER", "REVIEWER"}, "active": true}), 200, "Membership")
	f.expect(f.call(f.token, "GET", "/projects/project_demo/tasks", "", "", nil), 401, "")
	var status string
	if err := f.pool.QueryRow(context.Background(), `SELECT status FROM agent_sessions WHERE id=$1`, f.session).Scan(&status); err != nil || status != "REVOKED" {
		t.Fatal("delegation not durably revoked", err)
	}
}

func TestManagementConcurrentLastAdministrator(t *testing.T) {
	f := setup(t)
	f.expect(f.call("alice", "POST", "/projects/project_demo/members/user_bob/changes", newID("key"), `"1"`, Object{"roles": []string{"ADMIN"}, "active": true}), 200, "Membership")
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for _, pair := range []struct {
		actor, target string
		version       int
	}{{"alice", "user_bob", 2}, {"bob", "user_alice", 1}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- f.call(pair.actor, "POST", "/projects/project_demo/members/"+pair.target+"/changes", newID("key"), fmt.Sprintf(`"%d"`, pair.version), Object{"roles": []string{"MEMBER"}, "active": true}).Code
		}()
	}
	wg.Wait()
	close(codes)
	success := 0
	for c := range codes {
		if c == 200 {
			success++
		} else if c != 403 && c != 409 {
			t.Fatalf("unexpected status %d", c)
		}
	}
	if success != 1 {
		t.Fatalf("expected exactly one demotion, got %d", success)
	}
}

func TestManagementArchivedProjectRevokesUnusedGrant(t *testing.T) {
	f := setupExecution(t)
	f.expect(f.call("alice", "POST", "/projects/project_demo/commands", newID("key"), `"1"`, Object{"command": "ARCHIVE", "reason": "No work"}), 200, "ManagementProject")
	f.expect(f.call(f.token, "GET", "/projects/project_demo/tasks", "", "", nil), 401, "")
	f.expect(f.call("alice", "POST", "/projects", newID("key"), "", Object{"name": "Next project"}), 201, "ManagementProject")
}

func TestProjectMembersListSplitActiveAndProjectScopedDeactivate(t *testing.T) {
	f := setupExecution(t)
	page := f.expect(f.call("alice", "GET", "/projects/project_demo/members", "", "", nil), 200, "MembershipPage")
	items, _ := page["items"].([]any)
	foundBob := false
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		if textValue(item, "id") != "user_bob" {
			continue
		}
		foundBob = true
		if item["membership_active"] != true || item["account_active"] != true || item["active"] != true {
			t.Fatalf("expected split active fields for bob: %#v", item)
		}
	}
	if !foundBob {
		t.Fatal("bob missing from members list")
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE human_users SET active=false WHERE id='user_viewer'`); err != nil {
		t.Fatal(err)
	}
	page = f.expect(f.call("alice", "GET", "/projects/project_demo/members", "", "", nil), 200, "MembershipPage")
	items, _ = page["items"].([]any)
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		if textValue(item, "id") != "user_viewer" {
			continue
		}
		if item["membership_active"] != true || item["account_active"] != false || item["active"] != false {
			t.Fatalf("viewer should expose inactive account while membership stays active: %#v", item)
		}
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE human_users SET active=true WHERE id='user_viewer'`); err != nil {
		t.Fatal(err)
	}

	other := f.expect(f.call("alice", "POST", "/projects", newID("key"), "", Object{"name": "Sister project", "reason": "Scope check"}), 201, "ManagementProject")
	otherPath := "/projects/" + textValue(other, "id")
	f.expect(f.call("alice", "POST", otherPath+"/members", newID("key"), "", Object{"user_id": "user_bob", "roles": []string{"MEMBER"}, "reason": "Cross project"}), 201, "Membership")
	otherAgent := f.expect(f.call("bob", "POST", "/agents", newID("key"), "", Object{"project_id": textValue(other, "id"), "manifest": f.manifest}), 201, "M2AgentIdentity")
	otherGrant := f.expect(f.call("bob", "POST", "/agent-sessions", newID("key"), "", Object{
		"project_id": textValue(other, "id"), "agent_id": otherAgent["id"],
		"scopes":     []string{"tasks:read", "runs:claim", "runs:write", "context:read", "artifacts:write", "events:read"},
		"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
	}), 201, "M2SessionGrant")
	otherSession := textValue(otherGrant["session"].(map[string]any), "id")
	otherToken := textValue(otherGrant, "access_token")

	task := f.readyTask()
	ownerBefore := textValue(task, "owner_user_id")
	f.expect(f.call("bob", "POST", "/projects/project_demo/members/user_alice/changes", newID("key"), `"1"`, Object{"roles": []string{"ADMIN"}, "active": false, "reason": "Not admin"}), 403, "")
	changed := f.expect(f.call("alice", "POST", "/projects/project_demo/members/user_bob/changes", newID("key"), `"1"`, Object{"roles": []string{"MEMBER", "REVIEWER"}, "active": false, "reason": "Leave p1 only"}), 200, "Membership")
	if changed["membership_active"] != false || changed["account_active"] != true || changed["active"] != false {
		t.Fatalf("deactivate response fields: %#v", changed)
	}
	f.expect(f.call("bob", "GET", "/projects/project_demo/tasks", "", "", nil), 404, "")
	f.expect(f.call(f.token, "GET", "/projects/project_demo/tasks", "", "", nil), 401, "")
	f.expect(f.call("bob", "GET", otherPath, "", "", nil), 200, "ManagementProject")
	f.expect(f.call(otherToken, "GET", otherPath+"/tasks", "", "", nil), 200, "TaskPage")
	f.expect(f.call("bob", "GET", "/me", "", "", nil), 200, "Human")
	var demoStatus, otherStatus string
	if err := f.pool.QueryRow(context.Background(), `SELECT status FROM agent_sessions WHERE id=$1`, f.session).Scan(&demoStatus); err != nil || demoStatus != "REVOKED" {
		t.Fatal("demo project session not revoked", err, demoStatus)
	}
	if err := f.pool.QueryRow(context.Background(), `SELECT status FROM agent_sessions WHERE id=$1`, otherSession).Scan(&otherStatus); err != nil || otherStatus != "ACTIVE" {
		t.Fatal("other project session must stay active", err, otherStatus)
	}
	var accountActive bool
	if err := f.pool.QueryRow(context.Background(), `SELECT active FROM human_users WHERE id='user_bob'`).Scan(&accountActive); err != nil || !accountActive {
		t.Fatal("account-level active must stay true after project deactivate", err)
	}
	var ownerAfter string
	if err := f.pool.QueryRow(context.Background(), `SELECT owner_user_id FROM tasks WHERE id=$1`, task["id"]).Scan(&ownerAfter); err != nil || ownerAfter != ownerBefore {
		t.Fatal("tasks must not auto-reassign on project deactivate", err, ownerAfter, ownerBefore)
	}
	audits := f.expect(f.call("alice", "GET", "/projects/project_demo/audit-records", "", "", nil), 200, "AuditPage")
	foundAudit := false
	for _, raw := range audits["items"].([]any) {
		item, _ := raw.(map[string]any)
		if textValue(item, "resource_id") == "user_bob" && strings.Contains(fmt.Sprint(item["action"]), "/members/{user}/changes") {
			foundAudit = true
			break
		}
	}
	if !foundAudit {
		t.Fatal("project deactivate missing audit record")
	}
	f.expect(f.call("alice", "POST", "/projects/project_demo/members/user_alice/changes", newID("key"), `"1"`, Object{"roles": []string{"ADMIN"}, "active": false, "reason": "Last admin"}), 409, "")
}

func TestOrganizationAdminCanCreateProjectWithoutProjectAdmin(t *testing.T) {
	f := setup(t)
	if _, err := f.pool.Exec(context.Background(), `UPDATE memberships SET roles=ARRAY['MEMBER']::text[] WHERE user_id='user_alice'`); err != nil {
		t.Fatal(err)
	}
	created := f.expect(f.call("alice", "POST", "/projects", newID("key"), "", Object{"name": "Org-admin created", "reason": "C3"}), 201, "ManagementProject")
	if created["status"] != "ACTIVE" {
		t.Fatalf("expected ACTIVE project, got %#v", created)
	}
	path := "/projects/" + textValue(created, "id")
	details := f.expect(f.call("alice", "GET", path, "", "", nil), 200, "ManagementProject")
	if details["status"] != "ACTIVE" {
		t.Fatalf("created project not readable: %#v", details)
	}
}

func TestOrganizationAdminAccountDeactivate(t *testing.T) {
	f := setupExecution(t)
	me := f.expect(f.call("alice", "GET", "/me", "", "", nil), 200, "Human")
	if me["is_org_admin"] != true {
		t.Fatalf("alice should be org admin: %#v", me)
	}
	bobMe := f.expect(f.call("bob", "GET", "/me", "", "", nil), 200, "Human")
	if bobMe["is_org_admin"] != false {
		t.Fatalf("bob must not be org admin: %#v", bobMe)
	}
	orgPage := f.expect(f.call("alice", "GET", "/organization/members", "", "", nil), 200, "ManagementHumanPage")
	foundAlice := false
	for _, raw := range orgPage["items"].([]any) {
		item, _ := raw.(map[string]any)
		if textValue(item, "id") != "user_alice" {
			continue
		}
		foundAlice = true
		if item["is_org_admin"] != true || item["account_active"] != true || item["active"] != true {
			t.Fatalf("org member fields: %#v", item)
		}
	}
	if !foundAlice {
		t.Fatal("alice missing from organization members")
	}

	f.expect(f.call("alice", "POST", "/projects/project_demo/members/user_bob/changes", newID("key"), `"1"`, Object{"roles": []string{"ADMIN", "MEMBER", "REVIEWER"}, "active": true, "reason": "Project admin only"}), 200, "Membership")
	f.expect(f.call("bob", "POST", "/organization/members/user_viewer/changes", newID("key"), "", Object{"active": false, "reason": "Project admin cannot"}), 403, "")
	var stillActive bool
	if err := f.pool.QueryRow(context.Background(), `SELECT active FROM human_users WHERE id='user_viewer'`).Scan(&stillActive); err != nil || !stillActive {
		t.Fatal("project ADMIN must not change human_users.active", err, stillActive)
	}

	other := f.expect(f.call("alice", "POST", "/projects", newID("key"), "", Object{"name": "Account scope", "reason": "US-14b"}), 201, "ManagementProject")
	otherPath := "/projects/" + textValue(other, "id")
	f.expect(f.call("alice", "POST", otherPath+"/members", newID("key"), "", Object{"user_id": "user_bob", "roles": []string{"MEMBER"}, "reason": "Cross project"}), 201, "Membership")
	otherAgent := f.expect(f.call("bob", "POST", "/agents", newID("key"), "", Object{"project_id": textValue(other, "id"), "manifest": f.manifest}), 201, "M2AgentIdentity")
	otherGrant := f.expect(f.call("bob", "POST", "/agent-sessions", newID("key"), "", Object{
		"project_id": textValue(other, "id"), "agent_id": otherAgent["id"],
		"scopes":     []string{"tasks:read", "runs:claim", "runs:write", "context:read", "artifacts:write", "events:read"},
		"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
	}), 201, "M2SessionGrant")
	otherSession := textValue(otherGrant["session"].(map[string]any), "id")
	otherToken := textValue(otherGrant, "access_token")

	f.expect(f.call("alice", "POST", "/organization/members/user_alice/changes", newID("key"), "", Object{"active": false, "reason": "Last org admin"}), 409, "")
	var aliceActive bool
	if err := f.pool.QueryRow(context.Background(), `SELECT active FROM human_users WHERE id='user_alice'`).Scan(&aliceActive); err != nil || !aliceActive {
		t.Fatal("LAST_ORG_ADMIN must leave account active", err, aliceActive)
	}

	changed := f.expect(f.call("alice", "POST", "/organization/members/user_bob/changes", newID("key"), "", Object{"active": false, "reason": "Leave company"}), 200, "ManagementHuman")
	if changed["active"] != false || changed["account_active"] != false || changed["is_org_admin"] != false {
		t.Fatalf("account deactivate response: %#v", changed)
	}
	var bobActive bool
	if err := f.pool.QueryRow(context.Background(), `SELECT active FROM human_users WHERE id='user_bob'`).Scan(&bobActive); err != nil || bobActive {
		t.Fatal("human_users.active must be false", err, bobActive)
	}
	f.expect(f.call("bob", "GET", "/me", "", "", nil), 403, "")
	f.expect(f.call(f.token, "GET", "/projects/project_demo/tasks", "", "", nil), 401, "")
	f.expect(f.call(otherToken, "GET", otherPath+"/tasks", "", "", nil), 401, "")
	var demoStatus, otherStatus string
	if err := f.pool.QueryRow(context.Background(), `SELECT status FROM agent_sessions WHERE id=$1`, f.session).Scan(&demoStatus); err != nil || demoStatus != "REVOKED" {
		t.Fatal("demo project session not revoked", err, demoStatus)
	}
	if err := f.pool.QueryRow(context.Background(), `SELECT status FROM agent_sessions WHERE id=$1`, otherSession).Scan(&otherStatus); err != nil || otherStatus != "REVOKED" {
		t.Fatal("all-project sessions must revoke", err, otherStatus)
	}
	audits := f.expect(f.call("alice", "GET", "/organization/audit-records", "", "", nil), 200, "ManagementAuditPage")
	foundAudit := false
	for _, raw := range audits["items"].([]any) {
		item, _ := raw.(map[string]any)
		if textValue(item, "resource_id") == "user_bob" && strings.Contains(fmt.Sprint(item["action"]), "/organization/members/") {
			foundAudit = true
			break
		}
	}
	if !foundAudit {
		t.Fatal("account deactivate missing organization audit")
	}
}

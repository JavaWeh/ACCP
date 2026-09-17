//go:build integration

package controlplane

import (
	"context"
	"fmt"
	"sync"
	"testing"
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
	f.expect(f.call("alice", "POST", "/projects/project_demo/commands", newID("key"), `"1"`, Object{"command": "ARCHIVE", "reason": "Must fail"}), 409, "")
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

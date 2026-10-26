package recovery

import (
	"strings"
	"testing"
)

func TestRelationDisplay(t *testing.T) {
	if got := relationDisplay("accp.task_contexts"); got != "task_contexts" {
		t.Fatalf("got %q", got)
	}
	if got := relationDisplay("task_contexts"); got != "task_contexts" {
		t.Fatalf("got %q", got)
	}
}

func TestRequiredPrivilegesIncludeTaskContextsDelete(t *testing.T) {
	found := false
	for _, p := range requiredPrivileges {
		if p.role == "accp_api" && relationDisplay(p.relation) == "task_contexts" && p.privilege == "DELETE" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("requiredPrivileges must include DELETE on task_contexts for accp_api")
	}
	if !strings.Contains(grantsFixCommand, "deploy/production/grants.sql") {
		t.Fatal("fix command must name grants.sql")
	}
}

func TestMissingPrivilegesErrorMessage(t *testing.T) {
	err := missingPrivilegesError([]string{"DELETE privilege on task_contexts for role accp_api"})
	msg := err.Error()
	for _, want := range []string{"DELETE", "task_contexts", "accp_api", "deploy/production/grants.sql"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message %q missing %q", msg, want)
		}
	}
}

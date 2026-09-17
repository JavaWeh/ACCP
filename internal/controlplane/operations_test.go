//go:build integration

package controlplane

import "testing"

func TestProjectOperationsAuthorization(t *testing.T) {
	f := setup(t)
	for _, route := range []string{"diagnostics", "event-failures", "recovery-items"} {
		path := "/projects/project_demo/" + route
		f.expect(f.call("alice", "GET", path, "", "", nil), 200, "")
		f.expect(f.call("viewer", "GET", path, "", "", nil), 403, "")
		f.expect(f.call("carol", "GET", path, "", "", nil), 404, "")
	}
}

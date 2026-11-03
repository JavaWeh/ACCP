//go:build integration

package controlplane

import (
	"testing"
)

// F8: the per-Run tool-invocation timeline is a read-only REVIEWER projection
// over existing invocations. It must filter strictly to one Run and reuse the
// same project/role gate as the project-level list (REVIEWER → 403, non-member
// / missing Run → 404), returning the standard {items, next_cursor} page.
func TestF8RunToolInvocationTimeline(t *testing.T) {
	f, _ := setupTools(t)
	policy, run, inv := toolIntent(f)

	// A second Run in the same project with its own invocation: it must never
	// leak into the first Run's timeline.
	other := f.claim(f.readyTask(), newID("key"))["run"].(map[string]any)
	otherInv := f.expect(f.runWrite(f.token, Object(other), "/tool-invocations", newID("key"), Object{"tool_id": policy["id"], "resource_version": "rev1", "arguments": Object{"value": "approved"}, "artifact_ids": []any{}}), 201, "M3Invocation")

	path := "/task-runs/" + textValue(run, "id") + "/tool-invocations"

	// REVIEWER (ADMIN is a superset) sees only this Run's invocation.
	page := f.expect(f.call("alice", "GET", path, "", "", nil), 200, "M3InvocationPage")
	items, ok := page["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("expected exactly one invocation for the Run, got %v", page["items"])
	}
	if _, present := page["next_cursor"]; !present {
		t.Fatal("page is missing next_cursor")
	}
	only := items[0].(map[string]any)
	if only["id"] != inv["id"] {
		t.Fatalf("timeline returned %v, want the Run's invocation %v", only["id"], inv["id"])
	}
	if only["id"] == otherInv["id"] {
		t.Fatal("another Run's invocation leaked into the timeline")
	}
	// The list projects document fields (status/binding) but never the raw
	// result body.
	if _, leaked := only["result"]; leaked {
		t.Fatal("timeline leaked raw tool result")
	}

	// A plain REVIEWER member is also allowed.
	f.expect(f.call("bob", "GET", path, "", "", nil), 200, "M3InvocationPage")
	// A project member without REVIEWER is forbidden.
	f.expect(f.call("viewer", "GET", path, "", "", nil), 403, "")
	// A non-member of the project cannot even learn the Run exists.
	f.expect(f.call("carol", "GET", path, "", "", nil), 404, "")
	// An unknown Run id is a 404 like any other missing resource.
	f.expect(f.call("alice", "GET", "/task-runs/run_missing/tool-invocations", "", "", nil), 404, "")
}

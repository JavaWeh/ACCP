//go:build integration

package controlplane

import (
	"context"
	"testing"
)

func TestM4ArtifactParentsRespectFrozenDependencies(t *testing.T) {
	f := setupExecution(t)
	upstream, downstream := f.readyTask(), f.readyTask()
	path := "/tasks/" + textValue(downstream, "id")
	f.expect(f.call("bob", "POST", path+"/dependencies", newID("key"), etagOf(downstream), Object{"predecessor_task_id": upstream["id"], "condition": Object{"kind": "ARTIFACT_ACCEPTED", "artifact_kind": "TEST_REPORT"}}), 201, "M2TaskDependency")
	upstreamRun := f.claim(upstream, newID("key"))["run"].(map[string]any)
	parent := f.storedEvidence(upstreamRun)
	f.expect(f.call("bob", "POST", "/artifacts/"+textValue(parent, "id")+"/reviews", newID("key"), etagOf(parent), Object{"decision": "ACCEPT", "content_digest": parent["content_digest"], "reason": "Human verified predecessor evidence"}), 200, "M2Artifact")
	if err := f.server.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	claimed := f.claim(downstream, newID("key"))
	run := claimed["run"].(map[string]any)
	if len(claimed["snapshot"].(map[string]any)["artifact_refs"].([]any)) != 1 {
		t.Fatal("missing frozen parent")
	}
	content := f.expect(f.runWrite(f.token, run, "/artifact-contents", newID("key"), Object{"content": "Downstream test evidence", "media_type": "text/plain"}), 201, "M2ArtifactContent")
	body := Object{"kind": "TEST_REPORT", "uri": content["uri"], "content_digest": content["content_digest"], "media_type": "text/plain", "parent_artifact_ids": []any{parent["id"]}}
	key := newID("key")
	child := f.expect(f.runWrite(f.token, run, "/artifacts", key, body), 201, "M2Artifact")
	replayed := f.expect(f.runWrite(f.token, run, "/artifacts", key, body), 201, "M2Artifact")
	if child["id"] != replayed["id"] || child["parent_artifact_ids"].([]any)[0] != parent["id"] {
		t.Fatal("parent provenance or idempotency was lost")
	}
	if child["provenance"].(map[string]any)["task_run_id"] != run["id"] {
		t.Fatal("parent replaced child execution provenance")
	}
	// A normal same-Run chain remains valid without accepting each intermediate.
	body["parent_artifact_ids"] = []any{child["id"]}
	f.expect(f.runWrite(f.token, run, "/artifacts", newID("key"), body), 201, "M2Artifact")
	// Even an accepted artifact from the predecessor is not implicit authority
	// if it was created after claim and therefore absent from the frozen input.
	unlisted := f.storedEvidence(upstreamRun)
	f.expect(f.call("bob", "POST", "/artifacts/"+textValue(unlisted, "id")+"/reviews", newID("key"), etagOf(unlisted), Object{"decision": "ACCEPT", "content_digest": unlisted["content_digest"], "reason": "Separate evidence"}), 200, "M2Artifact")
	for _, parentID := range []any{unlisted["id"], "artifact_missing"} {
		body["parent_artifact_ids"] = []any{parentID}
		f.expect(f.runWrite(f.token, run, "/artifacts", newID("key"), body), 422, "")
	}
	// Accepted versions are immutable, including through the database boundary.
	if _, err := f.pool.Exec(context.Background(), `UPDATE artifacts SET document=jsonb_set(document,'{version}',to_jsonb((document->>'version')::bigint+1)) WHERE id=$1`, parent["id"]); err == nil {
		t.Fatal("accepted parent version was mutable")
	}
}

package controlplane

import (
	"encoding/json"
	"strings"

	"github.com/JavaWeh/ACCP/internal/gitprovider"
)

func (s *Server) deliveryRoutes(routes map[string]operation) {
	additions := map[string]operation{
		"GET /api/v1/projects/{id}/artifacts":       {table: "projects", run: listResources("artifacts", "")},
		"GET /api/v1/task-runs/{id}/artifacts":      {table: "task_runs", scope: "tasks:read", run: listRunArtifacts},
		"POST /api/v1/artifacts/{id}/verifications": {table: "artifacts", role: "REVIEWER", schema: "M3Reason", conditional: true, run: verifyArtifact},
		"GET /api/v1/artifacts/{id}/verifications":  {table: "artifacts", run: listResources("artifact_verifications", "artifact_id")},
		"POST /api/v1/artifacts/{id}/reviews":       {table: "artifacts", role: "REVIEWER", schema: "M3ArtifactReview", conditional: true, run: reviewArtifact},
		"GET /api/v1/artifacts/{id}/reviews":        {table: "artifacts", run: listResources("artifact_reviews", "artifact_id")},
		"POST /api/v1/tasks/{id}/reviews":           {table: "tasks", schema: "M3TaskReview", conditional: true, run: reviewTask},
		"GET /api/v1/tasks/{id}/reviews":            {table: "tasks", run: listResources("task_reviews", "task_id")},
	}
	for k, v := range additions {
		routes[k] = v
	}
	s.governanceRoutes(routes)
}
func listRunArtifacts(q *request) (reply, error) {
	if e := artifactAccess(q, q.http.PathValue("id")); e != nil {
		return reply{}, e
	}
	return listResources("artifacts", "run_id")(q)
}
func saveArtifact(q *request, doc Object) error {
	doc["version"] = revision(doc, "version") + 1
	data, _ := json.Marshal(doc)
	_, e := q.tx.Exec(q.http.Context(), `UPDATE artifacts SET document=$1,verification_status=$2,acceptance_status=$3 WHERE id=$4 AND project_id=$5`, data, doc["verification_status"], doc["acceptance_status"], doc["id"], q.project)
	return e
}
func appendDeliveryRecord(q *request, table, column string, doc Object) error {
	data, e := json.Marshal(doc)
	if e != nil {
		return e
	}
	_, e = q.tx.Exec(q.http.Context(), `INSERT INTO `+table+`(id,`+column+`,project_id,organization_id,document) VALUES($1,$2,$3,$4,$5)`, doc["id"], doc[column], q.project, q.org, data)
	return e
}
func artifactRun(q *request, doc Object) (Object, error) {
	return readDocument(q, "task_runs", textValue(doc["provenance"].(map[string]any), "task_run_id"))
}
func verifyArtifact(q *request) (reply, error) {
	doc, e := readDocument(q, "artifacts", q.http.PathValue("id"))
	if e != nil {
		return reply{}, e
	}
	if e = match(q, number(doc, "version")); e != nil {
		return reply{}, e
	}
	if doc["acceptance_status"] != "PENDING" {
		return reply{}, fail(409, "ARTIFACT_FINAL", "Reviewed evidence cannot be changed.")
	}
	if doc["kind"] != "COMMIT" && doc["kind"] != "PULL_REQUEST" && doc["kind"] != "CODE_DIFF" {
		return reply{}, fail(422, "GIT_REFERENCE_REQUIRED", "Uploaded text is already verified by its stored digest.")
	}
	if strings.HasPrefix(textValue(doc, "uri"), "urn:") {
		return reply{}, fail(422, "GIT_REFERENCE_REQUIRED", "Use an external immutable Git reference.")
	}
	run, e := artifactRun(q, doc)
	if e != nil {
		return reply{}, e
	}
	task, e := readDocument(q, "tasks", textValue(run, "task_id"))
	if e != nil {
		return reply{}, e
	}
	repo, e := readDocument(q, "repositories", textValue(task, "repository_id"))
	if e != nil {
		return reply{}, e
	}
	provider := q.server.options.GitProvider
	if provider == nil {
		provider = &gitprovider.GitHub{}
	}
	evidence, verifyErr := provider.Verify(q.http.Context(), gitprovider.Reference{RepositoryURL: textValue(repo, "url"), URI: textValue(doc, "uri"), Kind: textValue(doc, "kind"), Revision: textValue(doc, "immutable_revision"), Digest: textValue(doc, "content_digest")})
	record := Object{"id": newID("verification"), "artifact_id": doc["id"], "organization_id": q.org, "project_id": q.project, "artifact_version": doc["version"], "verified_by_user_id": q.user, "created_at": now(), "status": "VERIFIED"}
	if verifyErr != nil {
		record["status"] = "FAILED"
		record["error_code"] = "PROVIDER_VERIFICATION_FAILED"
		doc["verification_status"] = "FAILED"
	} else {
		record["evidence"] = evidence
		doc["verification_status"] = "VERIFIED"
	}
	if e = appendDeliveryRecord(q, "artifact_verifications", "artifact_id", record); e != nil {
		return reply{}, e
	}
	if e = saveArtifact(q, doc); e != nil {
		return reply{}, e
	}
	if verifyErr == nil {
		e = emitEvent(q, "CODE_READY", textValue(doc, "id"), revision(doc, "version"), Object{"task_id": run["task_id"], "task_run_id": run["id"], "context_snapshot_id": run["context_snapshot_id"], "artifact_id": doc["id"], "immutable_revision": doc["immutable_revision"], "content_digest": doc["content_digest"]})
	}
	return entity(200, doc), e
}
func decideArtifact(q *request, doc Object, decision, reason string) (Object, error) {
	if doc["acceptance_status"] != "PENDING" {
		return nil, fail(409, "ARTIFACT_FINAL", "Create new evidence after a decision; review history is immutable.")
	}
	run, e := artifactRun(q, doc)
	if e != nil {
		return nil, e
	}
	task, e := readDocument(q, "tasks", textValue(run, "task_id"))
	if e != nil {
		return nil, e
	}
	if task["status"] == "CANCELED" || run["status"] == "CANCELED" || run["status"] == "LOST" || run["status"] == "FAILED" {
		return nil, fail(409, "RUN_NOT_REVIEWABLE", "Evidence from canceled, lost or failed execution cannot release dependencies.")
	}
	var apiVersion Object
	if decision == "ACCEPT" {
		if doc["verification_status"] != "VERIFIED" {
			return nil, fail(409, "UNVERIFIED_ARTIFACT", "Verify evidence before accepting it.")
		}
		if doc["kind"] == "API_DOCUMENT" {
			if !hasRole(q.roles, "REVIEWER") {
				return nil, fail(403, "REVIEWER_REQUIRED", "API contracts require a human reviewer.")
			}
			apiVersion, e = readDocument(q, "context_versions", textValue(doc, "context_version_id"))
			if e != nil {
				return nil, e
			}
			parent, e := readDocument(q, "contexts", textValue(apiVersion, "context_id"))
			if e != nil {
				return nil, e
			}
			if parent["type"] != "API" || apiVersion["status"] != "PUBLISHED" || apiVersion["content_digest"] != doc["content_digest"] {
				return nil, fail(409, "API_CONTEXT_MISMATCH", "Publish the API Context containing these exact bytes before accepting the artifact.")
			}
		}
	}
	record := Object{"id": newID("artifactreview"), "artifact_id": doc["id"], "artifact_version": doc["version"], "content_digest": doc["content_digest"], "project_id": q.project, "organization_id": q.org, "decision": decision, "reason": reason, "reviewed_by_user_id": q.user, "created_at": now()}
	doc["acceptance_status"] = "REJECTED"
	if decision == "ACCEPT" {
		doc["acceptance_status"] = "ACCEPTED"
	}
	if e = saveArtifact(q, doc); e != nil {
		return nil, e
	}
	if e = appendDeliveryRecord(q, "artifact_reviews", "artifact_id", record); e != nil {
		return nil, e
	}
	if decision == "ACCEPT" && apiVersion != nil {
		e = emitEvent(q, "API_READY", textValue(doc, "id"), revision(doc, "version"), Object{"task_id": run["task_id"], "task_run_id": run["id"], "context_snapshot_id": run["context_snapshot_id"], "artifact_id": doc["id"], "context_version_id": apiVersion["id"], "content_digest": doc["content_digest"], "accepted_by_user_id": q.user})
	}
	return record, e
}
func reviewArtifact(q *request) (reply, error) {
	doc, e := readDocument(q, "artifacts", q.http.PathValue("id"))
	if e != nil {
		return reply{}, e
	}
	if e = match(q, number(doc, "version")); e != nil {
		return reply{}, e
	}
	if q.body["content_digest"] != doc["content_digest"] {
		return reply{}, fail(412, "EVIDENCE_CHANGED", "Review digest must match the evidence.")
	}
	_, e = decideArtifact(q, doc, textValue(q.body, "decision"), textValue(q.body, "reason"))
	return entity(200, doc), e
}
func reviewTask(q *request) (reply, error) {
	task, e := readDocument(q, "tasks", q.http.PathValue("id"))
	if e != nil {
		return reply{}, e
	}
	if task["owner_user_id"] != q.user {
		return reply{}, fail(403, "OWNER_REQUIRED", "Only the current human Owner can accept or return a task.")
	}
	if e = match(q, number(task, "version")); e != nil {
		return reply{}, e
	}
	if task["status"] != "IN_REVIEW" {
		return reply{}, fail(409, "INVALID_TRANSITION", "Review requires IN_REVIEW.")
	}
	run, e := readDocument(q, "task_runs", textValue(q.body, "task_run_id"))
	if e != nil {
		return reply{}, e
	}
	if run["task_id"] != task["id"] || run["status"] != "SUCCEEDED" {
		return reply{}, fail(422, "INVALID_RUN", "Review must identify this task's successful candidate Run.")
	}
	var latest string
	if e = q.tx.QueryRow(q.http.Context(), `SELECT id FROM task_runs WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1`, task["id"]).Scan(&latest); e != nil {
		return reply{}, e
	}
	if latest != run["id"] {
		return reply{}, fail(409, "STALE_REVIEW", "A newer execution exists.")
	}
	refs := q.body["artifacts"].([]any)
	seen := map[string]bool{}
	ids := []any{}
	if q.body["decision"] == "ACCEPT" {
		var unresolved bool
		if e = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM tool_invocations WHERE run_id=$1 AND status IN ('AWAITING_APPROVAL','READY','RUNNING','UNKNOWN'))`, run["id"]).Scan(&unresolved); e != nil {
			return reply{}, e
		}
		if unresolved {
			return reply{}, fail(409, "TOOL_OUTCOME_UNRESOLVED", "Resolve pending or unknown tool operations before accepting this task.")
		}
		criteria := q.body["acceptance_checks"].([]any)
		if len(criteria) != len(task["acceptance_criteria"].([]any)) {
			return reply{}, fail(422, "ACCEPTANCE_INCOMPLETE", "Review every acceptance criterion.")
		}
		for _, ok := range criteria {
			if ok != true {
				return reply{}, fail(422, "ACCEPTANCE_INCOMPLETE", "All criteria must pass before acceptance.")
			}
		}
	}
	for _, raw := range refs {
		ref := raw.(map[string]any)
		id := textValue(ref, "artifact_id")
		if seen[id] {
			return reply{}, fail(422, "DUPLICATE_ARTIFACT", "Review each artifact once.")
		}
		seen[id] = true
		doc, e := readDocument(q, "artifacts", id)
		if e != nil {
			return reply{}, e
		}
		if doc["provenance"].(map[string]any)["task_run_id"] != run["id"] || doc["version"] != ref["version"] || doc["content_digest"] != ref["content_digest"] {
			return reply{}, fail(412, "EVIDENCE_CHANGED", "Review the exact current artifacts from this Run.")
		}
		if q.body["decision"] == "ACCEPT" {
			if doc["acceptance_status"] == "PENDING" {
				if _, e = decideArtifact(q, doc, "ACCEPT", textValue(q.body, "reason")); e != nil {
					return reply{}, e
				}
			}
			if doc["acceptance_status"] != "ACCEPTED" || doc["verification_status"] != "VERIFIED" {
				return reply{}, fail(409, "UNACCEPTED_ARTIFACT", "Accepted tasks require verified, accepted evidence.")
			}
		}
		ids = append(ids, id)
	}
	task["status"] = "BLOCKED"
	if q.body["decision"] == "ACCEPT" {
		task["status"] = "DONE"
	}
	if e = saveTask(q, task); e != nil {
		return reply{}, e
	}
	if _, e = q.tx.Exec(q.http.Context(), `UPDATE tasks SET retry_authorized=false WHERE id=$1`, task["id"]); e != nil {
		return reply{}, e
	}
	record := Object{"id": newID("taskreview"), "task_id": task["id"], "task_run_id": run["id"], "task_version": task["version"], "artifacts": refs, "decision": q.body["decision"], "reason": q.body["reason"], "acceptance_checks": q.body["acceptance_checks"], "reviewed_by_user_id": q.user, "project_id": q.project, "organization_id": q.org, "created_at": now()}
	data, _ := json.Marshal(record)
	if _, e = q.tx.Exec(q.http.Context(), `INSERT INTO task_reviews(id,task_id,run_id,project_id,organization_id,document) VALUES($1,$2,$3,$4,$5,$6)`, record["id"], task["id"], run["id"], q.project, q.org, data); e != nil {
		return reply{}, e
	}
	if task["status"] == "DONE" {
		e = emitEvent(q, "TASK_COMPLETED", textValue(task, "id"), revision(task, "version"), Object{"task_id": task["id"], "task_run_id": run["id"], "context_snapshot_id": run["context_snapshot_id"], "artifact_ids": ids, "reviewed_by_user_id": q.user})
	}
	return entity(200, task), e
}

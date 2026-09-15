package controlplane

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/jackc/pgx/v5"
)

func (s *Server) governanceRoutes(routes map[string]operation) {
	for k, v := range map[string]operation{
		"GET /api/v1/projects/{id}/agent-sessions":      {table: "projects", run: listProjectSessions},
		"GET /api/v1/projects/{id}/tool-backends":       {table: "projects", role: "ADMIN", run: toolBackends},
		"GET /api/v1/projects/{id}/tools":               {table: "projects", scope: "tools:invoke", run: listResources("tool_policies", "")},
		"POST /api/v1/projects/{id}/tools":              {table: "projects", role: "ADMIN", schema: "M3PolicyRequest", run: createPolicy},
		"POST /api/v1/tools/{id}/changes":               {table: "tool_policies", role: "ADMIN", schema: "M3PolicyRequest", conditional: true, run: changePolicy},
		"POST /api/v1/task-runs/{id}/tool-invocations":  {table: "task_runs", scope: "tools:invoke", agentOnly: true, schema: "M3InvocationRequest", conditional: true, fenced: true, run: requestInvocation},
		"GET /api/v1/tool-invocations/{id}":             {table: "tool_invocations", scope: "tools:invoke", run: getInvocation},
		"GET /api/v1/projects/{id}/tool-invocations":    {table: "projects", role: "REVIEWER", run: listResources("tool_invocations", "")},
		"POST /api/v1/tool-invocations/{id}/reconcile":  {table: "tool_invocations", role: "ADMIN", schema: "M3Reason", conditional: true, run: reconcileInvocation},
		"GET /api/v1/projects/{id}/approvals":           {table: "projects", role: "REVIEWER", run: listResources("approvals", "")},
		"GET /api/v1/approvals/{id}":                    {table: "approvals", role: "REVIEWER", run: getResource("approvals")},
		"POST /api/v1/approvals/{id}/decisions":         {table: "approvals", role: "REVIEWER", schema: "M3ApprovalDecision", conditional: true, run: decideApproval},
		"GET /api/v1/agent-sessions/{id}/gateway-token": {table: "agent_sessions", scope: "tools:invoke", run: gatewayGrant},
	} {
		routes[k] = v
	}
}
func listProjectSessions(q *request) (reply, error) {
	limit, cursor, e := pageParams(q.http)
	if e != nil {
		return reply{}, e
	}
	rows, e := q.tx.Query(q.http.Context(), `SELECT id FROM agent_sessions WHERE project_id=$1 AND organization_id=$2 AND id>$3 ORDER BY id LIMIT $4`, q.project, q.org, cursor, limit+1)
	if e != nil {
		return reply{}, e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return reply{}, e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return reply{}, e
	}
	items := []Object{}
	for _, id := range ids {
		p, e := session(q, id)
		if e != nil {
			return reply{}, e
		}
		items = append(items, p.document())
	}
	return page(q.http, items, limit), nil
}
func toolBackends(q *request) (reply, error) {
	items := []Object{}
	if q.server.options.Tools != nil {
		for _, b := range q.server.options.Tools.Backends {
			if b.ProjectID == q.project {
				risk := "HIGH"
				if b.ReadOnly {
					risk = "READ_ONLY"
				}
				items = append(items, Object{"id": b.ID, "resource_id": b.ResourceID, "risk": risk, "tool_schema_version": b.Version, "input_schema": b.InputSchema})
			}
		}
	}
	return reply{status: 200, body: Object{"items": items}}, nil
}
func policyDocument(q *request, id string, version int64) (Object, error) {
	b, e := q.server.options.Tools.Get(textValue(q.body, "backend_id"), q.project)
	if e != nil {
		return nil, fail(422, "UNKNOWN_TOOL", "An operator must configure this project tool first.")
	}
	risk := "HIGH"
	if b.ReadOnly {
		risk = "READ_ONLY"
	}
	return Object{"id": id, "project_id": q.project, "organization_id": q.org, "backend_id": b.ID, "name": q.body["name"], "resource_id": b.ResourceID, "resource_version": q.body["resource_version"], "enabled": q.body["enabled"], "risk": risk, "tool_schema_version": b.Version, "input_schema": b.InputSchema, "version": version, "created_by_user_id": q.user, "updated_at": now()}, nil
}
func createPolicy(q *request) (reply, error) {
	doc, e := policyDocument(q, newID("tool"), 1)
	if e != nil {
		return reply{}, e
	}
	data, _ := json.Marshal(doc)
	_, e = q.tx.Exec(q.http.Context(), `INSERT INTO tool_policies(id,project_id,organization_id,document) VALUES($1,$2,$3,$4)`, doc["id"], q.project, q.org, data)
	return entity(201, doc), e
}
func changePolicy(q *request) (reply, error) {
	old, e := readDocument(q, "tool_policies", q.http.PathValue("id"))
	if e != nil {
		return reply{}, e
	}
	if e = match(q, number(old, "version")); e != nil {
		return reply{}, e
	}
	doc, e := policyDocument(q, textValue(old, "id"), number(old, "version")+1)
	if e != nil {
		return reply{}, e
	}
	if doc["backend_id"] != old["backend_id"] {
		return reply{}, fail(422, "IMMUTABLE_BACKEND", "Create a new policy to register a different backend.")
	}
	doc["created_by_user_id"] = old["created_by_user_id"]
	data, _ := json.Marshal(doc)
	_, e = q.tx.Exec(q.http.Context(), `UPDATE tool_policies SET document=$1 WHERE id=$2 AND project_id=$3`, data, doc["id"], q.project)
	return entity(200, doc), e
}
func requestInvocation(q *request) (reply, error) {
	run, e := activeRun(q, true)
	if e != nil {
		return reply{}, e
	}
	policy, e := readDocument(q, "tool_policies", textValue(q.body, "tool_id"))
	if e != nil {
		return reply{}, e
	}
	b, e := q.server.options.Tools.Get(textValue(policy, "backend_id"), q.project)
	if e != nil {
		return reply{}, fail(403, "TOOL_UNAVAILABLE", "This tool is unavailable.")
	}
	if policy["enabled"] != true || policy["resource_version"] != q.body["resource_version"] || policy["tool_schema_version"] != b.Version {
		return reply{}, fail(412, "POLICY_CHANGED", "Refresh the enabled tool policy and resource version.")
	}
	args := q.body["arguments"].(map[string]any)
	if e = b.Validate(args); e != nil {
		return reply{}, fail(422, "INVALID_TOOL_ARGUMENTS", "Arguments do not match the configured tool schema.")
	}
	bytes, _ := json.Marshal(args)
	if len(bytes) > 65536 {
		return reply{}, fail(422, "ARGUMENTS_TOO_LARGE", "Tool arguments must be at most 64 KiB.")
	}
	ids := q.body["artifact_ids"].([]any)
	refs := []Object{}
	for _, raw := range ids {
		doc, e := readDocument(q, "artifacts", raw.(string))
		if e != nil {
			return reply{}, e
		}
		if doc["provenance"].(map[string]any)["task_run_id"] != run["id"] || doc["verification_status"] != "VERIFIED" {
			return reply{}, fail(422, "INVALID_TOOL_EVIDENCE", "Tool evidence must be verified and belong to this Run.")
		}
		refs = append(refs, doc)
	}
	if b.Kind == "git.merge" {
		matched := false
		for _, a := range refs {
			if a["kind"] == "PULL_REQUEST" && a["immutable_revision"] == args["commit_sha"] && a["uri"] == fmt.Sprintf("%s/pull/%v", b.RepositoryURL, args["pull_request"]) {
				matched = true
			}
		}
		if !matched {
			return reply{}, fail(422, "MERGE_EVIDENCE_REQUIRED", "Provide the verified pull request artifact for the exact approved head.")
		}
	}
	binding := Object{"session_id": q.session.ID, "task_run_id": run["id"], "tool_id": policy["id"], "tool_schema_version": b.Version, "resource_id": b.ResourceID, "resource_version": policy["resource_version"], "parameters_digest": auth.Digest(string(bytes)), "artifact_ids": ids, "policy_version": strconv.FormatInt(number(policy, "version"), 10), "expires_at": time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339Nano)}
	if sha, ok := args["commit_sha"]; ok {
		binding["commit_sha"] = sha
	}
	canonical, _ := json.Marshal(binding)
	provenance := Object{"task_run_id": run["id"]}
	for _, key := range []string{"task_id", "session_id", "agent_id", "owner_user_id", "delegated_by_user_id", "context_snapshot_id"} {
		provenance[key] = run[key]
	}
	doc := Object{"id": newID("invocation"), "project_id": q.project, "organization_id": q.org, "provenance": provenance, "binding": binding, "binding_digest": auth.Digest(string(canonical)), "parameters": args, "status": "READY", "version": int64(1), "created_at": now()}
	var approval Object
	if policy["risk"] != "READ_ONLY" {
		doc["status"] = "AWAITING_APPROVAL"
		doc["approval_id"] = newID("approval")
		approval = Object{"id": doc["approval_id"], "project_id": q.project, "organization_id": q.org, "invocation_id": doc["id"], "requester_user_id": q.user, "binding": binding, "binding_digest": doc["binding_digest"], "status": "PENDING", "version": int64(1)}
	}
	// Durable deduplication outlives the generic 24-hour HTTP response cache.
	var old []byte
	e = q.tx.QueryRow(q.http.Context(), `SELECT document FROM tool_invocations WHERE session_id=$1 AND dedupe_key=$2`, q.session.ID, q.http.Header.Get("Idempotency-Key")).Scan(&old)
	if e == nil {
		var prior Object
		_ = json.Unmarshal(old, &prior)
		pb := prior["binding"].(map[string]any)
		oldRefs, _ := json.Marshal(pb["artifact_ids"])
		newRefs, _ := json.Marshal(ids)
		if prior["provenance"].(map[string]any)["task_run_id"] != run["id"] || pb["tool_id"] != policy["id"] || pb["parameters_digest"] != binding["parameters_digest"] || pb["resource_version"] != binding["resource_version"] || string(oldRefs) != string(newRefs) {
			return reply{}, fail(409, "IDEMPOTENCY_CONFLICT", "This operation key is already bound.")
		}
		return entity(200, prior), nil
	}
	if e != pgx.ErrNoRows {
		return reply{}, e
	}
	data, _ := json.Marshal(doc)
	_, e = q.tx.Exec(q.http.Context(), `INSERT INTO tool_invocations(id,project_id,organization_id,run_id,session_id,policy_id,document,status,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, doc["id"], q.project, q.org, run["id"], q.session.ID, policy["id"], data, doc["status"], q.http.Header.Get("Idempotency-Key"))
	if e != nil {
		return reply{}, e
	}
	if approval != nil {
		if e = appendDeliveryRecord(q, "approvals", "invocation_id", approval); e != nil {
			return reply{}, e
		}
		e = emitEvent(q, "APPROVAL_REQUESTED", textValue(approval, "id"), 1, Object{"task_id": run["task_id"], "task_run_id": run["id"], "context_snapshot_id": run["context_snapshot_id"], "invocation_id": doc["id"], "approval_id": approval["id"], "binding_digest": doc["binding_digest"]})
	}
	return entity(201, doc), e
}
func getInvocation(q *request) (reply, error) {
	doc, e := readDocument(q, "tool_invocations", q.http.PathValue("id"))
	if e != nil {
		return reply{}, e
	}
	if q.session != nil && doc["provenance"].(map[string]any)["session_id"] != q.session.ID {
		return reply{}, fail(404, "NOT_FOUND", "Invocation not found.")
	}
	var stored []byte
	if e = q.tx.QueryRow(q.http.Context(), `SELECT result FROM tool_invocations WHERE id=$1 AND project_id=$2`, doc["id"], q.project).Scan(&stored); e != nil {
		return reply{}, e
	}
	if len(stored) > 0 {
		var result Object
		if e = json.Unmarshal(stored, &result); e != nil {
			return reply{}, e
		}
		doc["result"] = result
	}
	return entity(200, doc), nil
}
func saveInvocation(q *request, doc Object, result any) error {
	doc["version"] = revision(doc, "version") + 1
	data, _ := json.Marshal(doc)
	var encoded []byte
	if result != nil {
		encoded, _ = json.Marshal(result)
	}
	_, e := q.tx.Exec(q.http.Context(), `UPDATE tool_invocations SET document=$1,status=$2,result=coalesce($3,result),started_at=CASE WHEN $2='RUNNING' THEN clock_timestamp() ELSE started_at END WHERE id=$4 AND project_id=$5`, data, doc["status"], encoded, doc["id"], q.project)
	return e
}
func decideApproval(q *request) (reply, error) {
	doc, e := readDocument(q, "approvals", q.http.PathValue("id"))
	if e != nil {
		return reply{}, e
	}
	if e = match(q, number(doc, "version")); e != nil {
		return reply{}, e
	}
	if doc["requester_user_id"] == q.user {
		return reply{}, fail(403, "SEPARATION_REQUIRED", "A different human reviewer must decide this operation.")
	}
	if doc["status"] != "PENDING" {
		return reply{}, fail(409, "APPROVAL_FINAL", "An approval decision is immutable.")
	}
	if doc["binding_digest"] != q.body["binding_digest"] {
		return reply{}, fail(412, "BINDING_CHANGED", "Review the exact operation binding.")
	}
	invocation, e := readDocument(q, "tool_invocations", textValue(doc, "invocation_id"))
	if e != nil {
		return reply{}, e
	}
	if invocation["status"] != "AWAITING_APPROVAL" {
		return reply{}, fail(409, "INVOCATION_INACTIVE", "The pending operation is no longer executable.")
	}
	if e = validateInvocation(q, invocation, false); e != nil {
		return reply{}, e
	}
	doc["status"] = "REJECTED"
	invocation["status"] = "CANCELED"
	if q.body["decision"] == "APPROVE" {
		doc["status"] = "APPROVED"
		invocation["status"] = "READY"
	}
	doc["decided_by_user_id"] = q.user
	doc["decided_at"] = now()
	doc["reason"] = q.body["reason"]
	doc["version"] = number(doc, "version") + 1
	data, _ := json.Marshal(doc)
	if _, e = q.tx.Exec(q.http.Context(), `UPDATE approvals SET document=$1 WHERE id=$2`, data, doc["id"]); e != nil {
		return reply{}, e
	}
	if e = saveInvocation(q, invocation, nil); e != nil {
		return reply{}, e
	}
	p := invocation["provenance"].(map[string]any)
	e = emitEvent(q, "APPROVAL_DECIDED", textValue(doc, "id"), revision(doc, "version"), Object{"task_id": p["task_id"], "task_run_id": p["task_run_id"], "context_snapshot_id": p["context_snapshot_id"], "invocation_id": invocation["id"], "approval_id": doc["id"], "decision": doc["status"], "decided_by_user_id": q.user})
	return entity(200, doc), e
}

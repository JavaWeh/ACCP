package controlplane

import (
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type sessionPrincipal struct {
	ID, Project, Org, Agent, Human, Status, Protocol string
	Scopes                                           []string
	Expires                                          time.Time
	Version                                          int64
}

func session(q *request, id string) (*sessionPrincipal, error) {
	p := &sessionPrincipal{}
	err := q.tx.QueryRow(q.http.Context(), `SELECT id,project_id,organization_id,agent_id,delegated_by_user_id,scopes,expires_at,status,coalesce(protocol_version,''),version FROM agent_sessions WHERE id=$1`, id).Scan(&p.ID, &p.Project, &p.Org, &p.Agent, &p.Human, &p.Scopes, &p.Expires, &p.Status, &p.Protocol, &p.Version)
	if err == pgx.ErrNoRows {
		return nil, fail(401, "INVALID_SESSION", "Session is unavailable.")
	}
	return p, err
}
func (p *sessionPrincipal) active() bool { return p.Status == "ACTIVE" && time.Now().Before(p.Expires) }
func (p *sessionPrincipal) document() Object {
	status := p.Status
	if status == "ACTIVE" && !p.active() {
		status = "EXPIRED"
	}
	return Object{"id": p.ID, "project_id": p.Project, "organization_id": p.Org, "agent_id": p.Agent, "delegated_by_user_id": p.Human, "scopes": p.Scopes, "expires_at": p.Expires.UTC().Format(time.RFC3339Nano), "status": status, "version": p.Version}
}
func (s *Server) authenticate(q *request, token string, op operation) error {
	if strings.HasPrefix(token, "accp_s_") {
		if s.signer == nil {
			return fail(401, "INVALID_SESSION", "Session authentication is unavailable.")
		}
		id, err := s.signer.SessionID(token)
		if err != nil {
			return fail(401, "INVALID_SESSION", "Invalid Session credential.")
		}
		q.session, err = session(q, id)
		if err != nil {
			return err
		}
		if !q.session.active() {
			return fail(401, "SESSION_INACTIVE", "Session expired or was revoked.")
		}
		q.user, q.org, q.project = q.session.Human, q.session.Org, q.session.Project
		if op.scope == "" {
			return fail(403, "HUMAN_REQUIRED", "This operation requires a human identity.")
		}
		var active bool
		err = q.tx.QueryRow(q.http.Context(), `SELECT active FROM human_users WHERE id=$1 AND organization_id=$2 FOR SHARE`, q.user, q.org).Scan(&active)
		if err != nil || !active {
			return fail(403, "DELEGATOR_INACTIVE", "Human delegation is no longer valid.")
		}
		return nil
	}
	if op.agentOnly {
		return fail(403, "AGENT_SESSION_REQUIRED", "Use a delegated Agent Session.")
	}
	identity, err := s.auth.Authenticate(q.http.Context(), token)
	if err != nil {
		return fail(401, "UNAUTHENTICATED", "Invalid bearer credential.")
	}
	err = q.tx.QueryRow(q.http.Context(), `SELECT id,organization_id FROM human_users WHERE issuer=$1 AND subject=$2 AND active FOR SHARE`, identity.Issuer, identity.Subject).Scan(&q.user, &q.org)
	if err == pgx.ErrNoRows {
		return fail(403, "HUMAN_NOT_PROVISIONED", "An active human mapping is required.")
	}
	return err
}
func (s *Server) authorizeSession(q *request, op operation) error {
	if q.session == nil {
		return nil
	}
	p, err := session(q, q.session.ID)
	if err != nil {
		return err
	}
	if !p.active() {
		return fail(401, "SESSION_INACTIVE", "Session expired or was revoked.")
	}
	if p.Project != q.project || p.Org != q.org {
		return fail(404, "NOT_FOUND", "Resource not found.")
	}
	if op.scope != "handshake" && !slices.Contains(p.Scopes, op.scope) {
		return fail(403, "SCOPE_DENIED", "Session does not grant this operation.")
	}
	if q.http.Method == "POST" && !hasRole(q.roles, "MEMBER") {
		return fail(403, "DELEGATION_DENIED", "Current human membership no longer permits execution.")
	}
	q.session = p
	return nil
}
func (q *request) actorKey() string {
	if q.session != nil {
		return "session:" + q.session.ID
	}
	return "human:" + q.user
}
func (s *Server) hydrateGrant(q *request, op operation, r reply) (reply, error) {
	if !op.grant {
		return r, nil
	}
	body := r.body.(map[string]any)
	doc := body["session"].(map[string]any)
	p, err := session(q, textValue(doc, "id"))
	if err != nil {
		return reply{}, err
	}
	if !p.active() || p.Human != q.user || !hasRole(q.roles, "MEMBER") {
		return reply{}, fail(409, "GRANT_INACTIVE", "This grant is no longer available; create a new Session.")
	}
	// Reconstruct only after authorization. The persisted response never contains a token.
	copy := Object{}
	for k, v := range body {
		copy[k] = v
	}
	copy["access_token"] = s.signer.Token(p.ID)
	r.body = copy
	return r, nil
}
func (s *Server) authorizeReplay(q *request, op operation, r reply) error {
	if q.session == nil {
		return nil
	}
	if op.fenced {
		doc, err := readDocument(q, "task_runs", q.http.PathValue("id"))
		if err != nil {
			return err
		}
		// A duplicate terminal report is a receipt, never a renewed execution grant.
		receipt := strings.HasSuffix(q.http.URL.Path, "/reports") && (doc["status"] == "SUCCEEDED" || doc["status"] == "FAILED")
		return checkRun(q, doc, !receipt, false)
	}
	if strings.HasSuffix(q.http.URL.Path, "/claim") {
		doc := r.body.(map[string]any)["run"].(map[string]any)
		current, err := readDocument(q, "task_runs", textValue(doc, "id"))
		if err != nil {
			return err
		}
		return checkRun(q, current, true, false)
	}
	return nil
}
func registerAgent(q *request) (reply, error) {
	manifest := q.body["manifest"].(map[string]any)
	if err := negotiate(manifest); err != nil {
		return reply{}, err
	}
	doc := Object{"id": newID("agent"), "project_id": q.project, "organization_id": q.org, "registered_by_user_id": q.user, "registered_at": now()}
	for _, k := range []string{"adapter_id", "adapter_version"} {
		doc[k] = manifest[k]
	}
	client := manifest["client"].(map[string]any)
	doc["client_name"] = client["name"]
	doc["client_version"] = client["version"]
	data, _ := json.Marshal(doc)
	m, _ := json.Marshal(manifest)
	_, err := q.tx.Exec(q.http.Context(), `INSERT INTO agents(id,project_id,organization_id,document,manifest) VALUES($1,$2,$3,$4,$5)`, doc["id"], q.project, q.org, data, m)
	return reply{status: 201, body: doc, resource: textValue(doc, "id"), version: 1}, err
}
func negotiate(manifest Object) error {
	found := false
	for _, v := range manifest["protocol_versions"].([]any) {
		if v == "0.2" {
			found = true
		}
	}
	if !found {
		return fail(422, "PROTOCOL_UNSUPPORTED", "This server requires ACCP protocol 0.2.")
	}
	return nil
}
func createSession(q *request) (reply, error) {
	if q.server.signer == nil {
		return reply{}, fail(503, "SESSION_UNAVAILABLE", "Configure a persistent Session signing key.")
	}
	if _, err := readDocument(q, "agents", textValue(q.body, "agent_id")); err != nil {
		return reply{}, err
	}
	expiry, _ := time.Parse(time.RFC3339Nano, textValue(q.body, "expires_at"))
	if expiry.Before(time.Now().Add(30*time.Second)) || expiry.After(time.Now().Add(24*time.Hour)) {
		return reply{}, fail(422, "INVALID_EXPIRY", "Session lifetime must be between 30 seconds and 24 hours.")
	}
	scopes := []string{}
	for _, raw := range q.body["scopes"].([]any) {
		scope := raw.(string)
		if !slices.Contains([]string{"tasks:read", "runs:claim", "runs:write", "context:read", "artifacts:write", "events:read"}, scope) {
			return reply{}, fail(422, "INVALID_SCOPE", "Unknown execution scope.")
		}
		scopes = append(scopes, scope)
	}
	p := &sessionPrincipal{ID: newID("session"), Project: q.project, Org: q.org, Agent: textValue(q.body, "agent_id"), Human: q.user, Scopes: scopes, Expires: expiry, Status: "ACTIVE", Version: 1}
	_, err := q.tx.Exec(q.http.Context(), `INSERT INTO agent_sessions(id,project_id,organization_id,agent_id,delegated_by_user_id,scopes,expires_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE')`, p.ID, p.Project, p.Org, p.Agent, p.Human, p.Scopes, p.Expires)
	return reply{status: 201, body: Object{"session": p.document(), "token_type": "Bearer", "expires_at": p.document()["expires_at"]}, resource: p.ID, version: 1}, err
}
func getSession(q *request) (reply, error) {
	p, err := session(q, q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	return entity(200, p.document()), nil
}
func revokeSession(q *request) (reply, error) {
	p, err := session(q, q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	if p.Human != q.user && !hasRole(q.roles, "ADMIN") {
		return reply{}, fail(403, "DELEGATOR_REQUIRED", "Only the delegator or administrator may revoke this Session.")
	}
	if err = match(q, p.Version); err != nil {
		return reply{}, err
	}
	if p.Status != "ACTIVE" {
		return reply{}, fail(409, "SESSION_INACTIVE", "Session is already inactive.")
	}
	p.Status = "REVOKED"
	p.Version++
	_, err = q.tx.Exec(q.http.Context(), `UPDATE agent_sessions SET status='REVOKED',version=$2 WHERE id=$1`, p.ID, p.Version)
	if err != nil {
		return reply{}, err
	}
	err = emitEvent(q, "SESSION_REVOKED", p.ID, p.Version, Object{"session_id": p.ID, "revoked_by_user_id": q.user})
	return entity(200, p.document()), err
}
func handshake(q *request) (reply, error) {
	var stored []byte
	err := q.tx.QueryRow(q.http.Context(), `SELECT manifest FROM agents WHERE id=$1`, q.session.Agent).Scan(&stored)
	if err != nil {
		return reply{}, err
	}
	var expected Object
	_ = json.Unmarshal(stored, &expected)
	manifest := q.body["manifest"].(map[string]any)
	a, _ := json.Marshal(expected)
	b, _ := json.Marshal(manifest)
	if string(a) != string(b) {
		return reply{}, fail(409, "MANIFEST_MISMATCH", "Use the manifest registered by the human delegator.")
	}
	if err = negotiate(manifest); err != nil {
		return reply{}, err
	}
	caps := Object{"claim": true, "context_read": true, "artifact_report": true, "heartbeat": true, "cancel": "cooperative", "notifications": []string{"poll"}, "auto_start": false}
	offered := manifest["capabilities"].(map[string]any)
	for _, n := range offered["notifications"].([]any) {
		if n == "sse" {
			caps["notifications"] = []string{"poll", "sse"}
		}
	}
	data, _ := json.Marshal(caps)
	_, err = q.tx.Exec(q.http.Context(), `UPDATE agent_sessions SET protocol_version='0.2',accepted_capabilities=$2,version=version+1 WHERE id=$1`, q.session.ID, data)
	return reply{status: 200, resource: q.session.ID, version: q.session.Version + 1, body: Object{"protocol_version": "0.2", "accepted_capabilities": caps, "api_base_uri": q.server.options.PublicURL + "/api/v1"}}, err
}

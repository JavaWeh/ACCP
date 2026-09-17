package controlplane

import (
	"encoding/json"
	"net/url"
	"strings"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/jackc/pgx/v5"
)

var managementSchemas = []string{"CreateProject", "ProjectChange", "ProjectCommand", "RegisterHuman", "AddMember", "RegisterRepository", "Project", "Human", "AuditPage"}

func (s *Server) managementRoutes(routes map[string]operation) {
	for path, op := range map[string]operation{
		"GET /api/v1/organization/members":        {organization: true, run: organizationMembers},
		"POST /api/v1/organization/members":       {organization: true, schema: "ManagementRegisterHuman", run: registerHuman},
		"GET /api/v1/organization/audit-records":  {organization: true, run: organizationAudit},
		"POST /api/v1/projects":                   {organization: true, schema: "ManagementCreateProject", run: createProject},
		"GET /api/v1/projects/{id}":               {table: "projects", run: projectDetails},
		"POST /api/v1/projects/{id}/changes":      {table: "projects", role: "ADMIN", conditional: true, schema: "ManagementProjectChange", run: changeProject},
		"POST /api/v1/projects/{id}/commands":     {table: "projects", role: "ADMIN", conditional: true, archivedWrite: true, schema: "ManagementProjectCommand", run: projectCommand},
		"POST /api/v1/projects/{id}/members":      {table: "projects", role: "ADMIN", schema: "ManagementAddMember", run: addMember},
		"POST /api/v1/projects/{id}/repositories": {table: "projects", role: "ADMIN", schema: "ManagementRegisterRepository", run: registerRepository},
	} {
		routes[path] = op
	}
}

// Organization mutations have their own journal: they must not invent a project membership.
func (s *Server) executeOrganization(q *request, op operation) (reply, error) {
	ctx := q.http.Context()
	var org string
	if err := q.tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id=$1 FOR UPDATE`, q.org).Scan(&org); err != nil {
		return reply{}, err
	}
	var admin string
	err := q.tx.QueryRow(ctx, `SELECT project_id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND active AND 'ADMIN'=ANY(roles) ORDER BY project_id LIMIT 1 FOR SHARE`, q.org, q.user).Scan(&admin)
	if err == pgx.ErrNoRows {
		return reply{}, fail(403, "ADMIN_REQUIRED", "An active project administrator is required.")
	}
	if err != nil {
		return reply{}, err
	}
	if q.http.Method != "POST" {
		return op.run(q)
	}
	key := q.http.Header.Get("Idempotency-Key")
	if len(key) < 8 || len(key) > 128 || strings.TrimSpace(key) != key {
		return reply{}, fail(400, "IDEMPOTENCY_KEY_REQUIRED", "Use an Idempotency-Key of 8 to 128 characters.")
	}
	data, err := json.Marshal(q.body)
	if err != nil {
		return reply{}, err
	}
	route := q.http.Method + " " + q.http.URL.Path
	digest := auth.Digest(route + "\n" + string(data))
	var stored string
	var cached reply
	err = q.tx.QueryRow(ctx, `SELECT digest,status,body,etag FROM organization_idempotency WHERE organization_id=$1 AND actor_id=$2 AND route=$3 AND key=$4 AND expires_at>now()`, q.org, q.user, route, key).Scan(&stored, &cached.status, &data, &cached.etag)
	if err == nil {
		if stored != digest {
			return reply{}, fail(409, "IDEMPOTENCY_CONFLICT", "This key identifies another request.")
		}
		err = json.Unmarshal(data, &cached.body)
		return cached, err
	}
	if err != pgx.ErrNoRows {
		return reply{}, err
	}
	result, err := op.run(q)
	if err != nil {
		return reply{}, err
	}
	data, err = json.Marshal(result.body)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(ctx, `INSERT INTO organization_idempotency(organization_id,actor_id,route,key,digest,status,body,etag) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,actor_id,route,key) DO UPDATE SET digest=EXCLUDED.digest,status=EXCLUDED.status,body=EXCLUDED.body,etag=EXCLUDED.etag,expires_at=now()+interval '24 hours'`, q.org, q.user, route, key, digest, result.status, data, result.etag)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(ctx, `INSERT INTO organization_audit(id,organization_id,actor_id,action,resource_id,result,reason,trace_id) VALUES($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7)`, newID("audit"), q.org, q.user, route, result.resource, textValue(q.body, "reason"), q.trace)
	if err != nil {
		return reply{}, err
	}
	return result, q.tx.Commit(ctx)
}

func organizationMembers(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT id,display_name,active FROM human_users WHERE organization_id=$1 AND id>$2 ORDER BY id LIMIT $3`, q.org, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, name string
		var active bool
		if err = rows.Scan(&id, &name, &active); err != nil {
			return reply{}, err
		}
		items = append(items, Object{"id": id, "organization_id": q.org, "display_name": name, "active": active, "kind": "HUMAN"})
	}
	return page(q.http, items, limit), rows.Err()
}

func registerHuman(q *request) (reply, error) {
	issuer := textValue(q.body, "issuer")
	if issuer != q.server.options.OIDCIssuer && !(issuer == "urn:accp:development" && q.server.options.AuthMode == "development") {
		return reply{}, fail(422, "INVALID_ISSUER", "Use the configured identity issuer.")
	}
	if strings.TrimSpace(textValue(q.body, "subject")) == "" || strings.TrimSpace(textValue(q.body, "display_name")) == "" {
		return reply{}, fail(422, "INVALID_HUMAN", "Subject and display name cannot be blank.")
	}
	id := newID("user")
	tag, err := q.tx.Exec(q.http.Context(), `INSERT INTO human_users(id,organization_id,issuer,subject,display_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT(issuer,subject) DO NOTHING`, id, q.org, issuer, q.body["subject"], q.body["display_name"])
	if err != nil {
		return reply{}, err
	}
	if tag.RowsAffected() != 1 {
		return reply{}, fail(409, "IDENTITY_UNAVAILABLE", "This identity cannot be registered; use an existing authorized member if available.")
	}
	return reply{status: 201, resource: id, version: 1, body: Object{"id": id, "organization_id": q.org, "display_name": q.body["display_name"], "active": true, "kind": "HUMAN"}}, nil
}

func createProject(q *request) (reply, error) {
	name := strings.TrimSpace(textValue(q.body, "name"))
	if name == "" {
		return reply{}, fail(422, "INVALID_NAME", "Project name cannot be blank.")
	}
	id := newID("project")
	_, err := q.tx.Exec(q.http.Context(), `INSERT INTO projects(id,organization_id,name) VALUES($1,$2,$3)`, id, q.org, name)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO memberships(project_id,organization_id,user_id,roles) VALUES($1,$2,$3,ARRAY['ADMIN']::text[])`, id, q.org, q.user)
	if err != nil {
		return reply{}, err
	}
	return entity(201, Object{"id": id, "organization_id": q.org, "name": name, "status": "ACTIVE", "version": int64(1)}), nil
}

func projectDetails(q *request) (reply, error) {
	var name, status string
	var version int64
	err := q.tx.QueryRow(q.http.Context(), `SELECT name,status,version FROM projects WHERE id=$1 AND organization_id=$2`, q.project, q.org).Scan(&name, &status, &version)
	return entity(200, Object{"id": q.project, "organization_id": q.org, "name": name, "status": status, "version": version}), err
}

func changeProject(q *request) (reply, error) {
	current, err := projectDetails(q)
	if err != nil {
		return reply{}, err
	}
	if err = match(q, current.version); err != nil {
		return reply{}, err
	}
	name := strings.TrimSpace(textValue(q.body, "name"))
	if name == "" {
		return reply{}, fail(422, "INVALID_NAME", "Project name cannot be blank.")
	}
	_, err = q.tx.Exec(q.http.Context(), `UPDATE projects SET name=$2,version=version+1,updated_at=now() WHERE id=$1`, q.project, name)
	if err != nil {
		return reply{}, err
	}
	return projectDetails(q)
}

func projectCommand(q *request) (reply, error) {
	current, err := projectDetails(q)
	if err != nil {
		return reply{}, err
	}
	if err = match(q, current.version); err != nil {
		return reply{}, err
	}
	state := current.body.(Object)["status"]
	desired := "ACTIVE"
	if q.body["command"] == "ARCHIVE" {
		desired = "ARCHIVED"
		rows, e := q.tx.Query(q.http.Context(), `SELECT id,kind FROM (SELECT id,'task' AS kind FROM tasks WHERE project_id=$1 AND status NOT IN ('DONE','CANCELED') UNION ALL SELECT id,'run' FROM task_runs WHERE project_id=$1 AND status='RUNNING' UNION ALL SELECT id,'invocation' FROM tool_invocations WHERE project_id=$1 AND status IN ('AWAITING_APPROVAL','READY','RUNNING','UNKNOWN')) blockers ORDER BY kind,id LIMIT 20`, q.project)
		if e != nil {
			return reply{}, e
		}
		ids := []string{}
		for rows.Next() {
			var id, kind string
			if e = rows.Scan(&id, &kind); e != nil {
				rows.Close()
				return reply{}, e
			}
			ids = append(ids, kind+":"+id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return reply{}, e
		}
		if len(ids) > 0 {
			return reply{}, fail(409, "ARCHIVE_BLOCKED", "Finish or cancel tasks and reconcile operations first (up to 20): "+strings.Join(ids, ", "))
		}
	}
	if state == desired {
		return reply{}, fail(409, "INVALID_TRANSITION", "Project already has the requested state.")
	}
	if desired == "ARCHIVED" {
		if err = revokeManagedSessions(q, ""); err != nil {
			return reply{}, err
		}
	}
	_, err = q.tx.Exec(q.http.Context(), `UPDATE projects SET status=$2,version=version+1,updated_at=now() WHERE id=$1`, q.project, desired)
	if err != nil {
		return reply{}, err
	}
	return projectDetails(q)
}

func addMember(q *request) (reply, error) {
	var name string
	err := q.tx.QueryRow(q.http.Context(), `SELECT display_name FROM human_users WHERE id=$1 AND organization_id=$2 AND active`, q.body["user_id"], q.org).Scan(&name)
	if err == pgx.ErrNoRows {
		return reply{}, fail(422, "INVALID_MEMBER", "Select an active member of this enterprise.")
	}
	if err != nil {
		return reply{}, err
	}
	roles := []string{}
	for _, r := range q.body["roles"].([]any) {
		roles = append(roles, r.(string))
	}
	tag, err := q.tx.Exec(q.http.Context(), `INSERT INTO memberships(project_id,organization_id,user_id,roles) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO NOTHING`, q.project, q.org, q.body["user_id"], roles)
	if err != nil {
		return reply{}, err
	}
	if tag.RowsAffected() != 1 {
		return reply{}, fail(409, "MEMBER_EXISTS", "Use the versioned member change operation to update or restore this member.")
	}
	return entity(201, Object{"id": q.body["user_id"], "organization_id": q.org, "project_id": q.project, "display_name": name, "roles": roles, "active": true, "version": int64(1)}), nil
}

func registerRepository(q *request) (reply, error) {
	u, err := url.Parse(textValue(q.body, "url"))
	if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Host, "github.com") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return reply{}, fail(422, "INVALID_REPOSITORY", "Use an HTTPS github.com owner/repository URL without credentials or query.")
	}
	parts := strings.Split(strings.Trim(strings.TrimSuffix(u.Path, ".git"), "/"), "/")
	if len(parts) != 2 || !repositoryPart(parts[0]) || !repositoryPart(parts[1]) {
		return reply{}, fail(422, "INVALID_REPOSITORY", "Use a GitHub owner and repository path.")
	}
	canonical := "https://github.com/" + strings.ToLower(strings.Join(parts, "/"))
	var exists bool
	err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM repositories WHERE project_id=$1 AND lower(rtrim(regexp_replace(document->>'url','\.git$',''),'/'))=$2)`, q.project, canonical).Scan(&exists)
	if err != nil {
		return reply{}, err
	}
	if exists {
		return reply{}, fail(409, "REPOSITORY_EXISTS", "Repository is already registered in this project.")
	}
	branch := strings.TrimSpace(textValue(q.body, "default_branch"))
	if branch == "" || strings.ContainsAny(branch, "\x00\r\n") {
		return reply{}, fail(422, "INVALID_BRANCH", "A default branch is required.")
	}
	doc := Object{"id": newID("repo"), "project_id": q.project, "organization_id": q.org, "provider_id": "github", "url": canonical, "default_branch": branch}
	data, _ := json.Marshal(doc)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO repositories(id,project_id,organization_id,document) VALUES($1,$2,$3,$4)`, doc["id"], q.project, q.org, data)
	return reply{status: 201, body: doc, resource: textValue(doc, "id"), version: 1}, err
}

func repositoryPart(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

func revokeManagedSessions(q *request, human string) error {
	rows, err := q.tx.Query(q.http.Context(), `UPDATE agent_sessions SET status='REVOKED',version=version+1 WHERE project_id=$1 AND status='ACTIVE' AND ($2='' OR delegated_by_user_id=$2) RETURNING id,version`, q.project, human)
	if err != nil {
		return err
	}
	type revoked struct {
		id      string
		version int64
	}
	items := []revoked{}
	for rows.Next() {
		var r revoked
		if err = rows.Scan(&r.id, &r.version); err != nil {
			rows.Close()
			return err
		}
		items = append(items, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, r := range items {
		if err = emitEvent(q, "SESSION_REVOKED", r.id, r.version, Object{"session_id": r.id, "revoked_by_user_id": q.user}); err != nil {
			return err
		}
	}
	return nil
}

func organizationAudit(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT id,actor_id,action,resource_id,result,reason,trace_id,recorded_at FROM organization_audit WHERE organization_id=$1 AND id>$2 ORDER BY id LIMIT $3`, q.org, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, actor, action, resource, result, reason, trace string
		var stamp time.Time
		if err = rows.Scan(&id, &actor, &action, &resource, &result, &reason, &trace, &stamp); err != nil {
			return reply{}, err
		}
		items = append(items, Object{"id": id, "organization_id": q.org, "actor_id": actor, "action": action, "resource_id": resource, "result": result, "reason": reason, "trace_id": trace, "recorded_at": stamp.UTC().Format(time.RFC3339Nano)})
	}
	return page(q.http, items, limit), rows.Err()
}

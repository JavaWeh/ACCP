package controlplane

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/jackc/pgx/v5"
)

var managementSchemas = []string{"CreateProject", "ProjectChange", "ProjectCommand", "RegisterHuman", "HumanChange", "AddMember", "RegisterRepository", "Project", "Human", "HumanPage", "AuditPage"}

func (s *Server) managementRoutes(routes map[string]operation) {
	for path, op := range map[string]operation{
		"GET /api/v1/organization/members":                        {organization: true, run: organizationMembers},
		"POST /api/v1/organization/members":                       {organization: true, schema: "ManagementRegisterHuman", run: registerHuman},
		"POST /api/v1/organization/members/{user}/changes":        {organization: true, orgAdminOnly: true, schema: "ManagementHumanChange", run: changeOrganizationMember},
		"GET /api/v1/organization/audit-records":                  {organization: true, run: organizationAudit},
		"GET /api/v1/organization/execution-audit-records":        {organization: true, orgAdminOnly: true, run: organizationExecutionAudit},
		"GET /api/v1/organization/execution-audit-records/export": {organization: true, orgAdminOnly: true, run: exportOrganizationAudit},
		"POST /api/v1/projects":                                   {organization: true, schema: "ManagementCreateProject", run: createProject},
		"GET /api/v1/projects/{id}":                               {table: "projects", run: projectDetails},
		"POST /api/v1/projects/{id}/changes":                      {table: "projects", role: "ADMIN", conditional: true, schema: "ManagementProjectChange", run: changeProject},
		"POST /api/v1/projects/{id}/commands":                     {table: "projects", role: "ADMIN", conditional: true, archivedWrite: true, schema: "ManagementProjectCommand", run: projectCommand},
		"POST /api/v1/projects/{id}/members":                      {table: "projects", role: "ADMIN", schema: "ManagementAddMember", run: addMember},
		"POST /api/v1/projects/{id}/repositories":                 {table: "projects", role: "ADMIN", schema: "ManagementRegisterRepository", run: registerRepository},
	} {
		routes[path] = op
	}
}

// Organization mutations have their own journal: they must not invent a project membership.
// Account-level deactivate is intentionally asymmetric vs registerHuman: orgAdminOnly routes
// require is_org_admin; other organization routes accept org ADMIN or any project ADMIN.
func (s *Server) executeOrganization(q *request, op operation) (reply, error) {
	ctx := q.http.Context()
	var org string
	if err := q.tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id=$1 FOR UPDATE`, q.org).Scan(&org); err != nil {
		return reply{}, err
	}
	var orgAdmin bool
	err := q.tx.QueryRow(ctx, `SELECT is_org_admin FROM human_users WHERE id=$1 AND organization_id=$2 AND active`, q.user, q.org).Scan(&orgAdmin)
	if err == pgx.ErrNoRows {
		return reply{}, fail(403, "FORBIDDEN", "An active human mapping is required.")
	}
	if err != nil {
		return reply{}, err
	}
	if op.orgAdminOnly {
		if !orgAdmin {
			return reply{}, fail(403, "ORG_ADMIN_REQUIRED", "An organization administrator is required.")
		}
	} else {
		var admin string
		err = q.tx.QueryRow(ctx, `SELECT project_id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND active AND 'ADMIN'=ANY(roles) ORDER BY project_id LIMIT 1 FOR SHARE`, q.org, q.user).Scan(&admin)
		if err == pgx.ErrNoRows {
			if !orgAdmin {
				return reply{}, fail(403, "ADMIN_REQUIRED", "An active project administrator is required.")
			}
		} else if err != nil {
			return reply{}, err
		}
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
		if err = json.Unmarshal(data, &cached.body); err != nil {
			return reply{}, err
		}
		cached.replayed = true
		return cached, nil
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

func humanDoc(id, org, name string, active, orgAdmin bool) Object {
	return Object{"id": id, "organization_id": org, "display_name": name, "active": active, "account_active": active, "is_org_admin": orgAdmin, "kind": "HUMAN"}
}

func organizationMembers(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT id,display_name,active,is_org_admin FROM human_users WHERE organization_id=$1 AND id>$2 ORDER BY id LIMIT $3`, q.org, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, name string
		var active, orgAdmin bool
		if err = rows.Scan(&id, &name, &active, &orgAdmin); err != nil {
			return reply{}, err
		}
		items = append(items, humanDoc(id, q.org, name, active, orgAdmin))
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
	return reply{status: 201, resource: id, version: 1, body: humanDoc(id, q.org, textValue(q.body, "display_name"), true, false)}, nil
}

// changeOrganizationMember fans the organization-ADMIN account journal out to three
// shapes carried by HumanChange (schema oneOf): {active:false} deactivate,
// {active:true} reactivate, and {is_org_admin:bool} grant/revoke. Reactivate is
// deliberately not symmetric with deactivate: it does not re-add project memberships
// and does not re-issue revoked agent sessions.
func changeOrganizationMember(q *request) (reply, error) {
	target := q.http.PathValue("user")
	var name string
	var active, orgAdmin bool
	err := q.tx.QueryRow(q.http.Context(), `SELECT display_name,active,is_org_admin FROM human_users WHERE id=$1 AND organization_id=$2 FOR UPDATE`, target, q.org).Scan(&name, &active, &orgAdmin)
	if err == pgx.ErrNoRows {
		return reply{}, fail(404, "NOT_FOUND", "Provisioned human not found.")
	}
	if err != nil {
		return reply{}, err
	}
	if desired, ok := q.body["is_org_admin"].(bool); ok {
		return changeOrganizationAdmin(q, target, name, active, orgAdmin, desired)
	}
	if q.body["active"] == true {
		if active {
			return reply{status: 200, resource: target, version: 1, body: humanDoc(target, q.org, name, true, orgAdmin)}, nil
		}
		if _, err = q.tx.Exec(q.http.Context(), `UPDATE human_users SET active=true WHERE id=$1 AND organization_id=$2`, target, q.org); err != nil {
			return reply{}, err
		}
		return reply{status: 200, resource: target, version: 1, body: humanDoc(target, q.org, name, true, orgAdmin)}, nil
	}
	if !active {
		return reply{status: 200, resource: target, version: 1, body: humanDoc(target, q.org, name, false, orgAdmin)}, nil
	}
	if orgAdmin {
		if err = requireRemainingOrgAdmin(q, target); err != nil {
			return reply{}, err
		}
	}
	_, err = q.tx.Exec(q.http.Context(), `UPDATE human_users SET active=false WHERE id=$1 AND organization_id=$2`, target, q.org)
	if err != nil {
		return reply{}, err
	}
	if err = revokeDelegatedSessionsEverywhere(q, target); err != nil {
		return reply{}, err
	}
	return reply{status: 200, resource: target, version: 1, body: humanDoc(target, q.org, name, false, orgAdmin)}, nil
}

func changeOrganizationAdmin(q *request, target, name string, active, orgAdmin, desired bool) (reply, error) {
	if desired {
		if !active {
			return reply{}, fail(422, "INACTIVE_ACCOUNT", "Reactivate this account before granting organization administrator.")
		}
		if !orgAdmin {
			if _, err := q.tx.Exec(q.http.Context(), `UPDATE human_users SET is_org_admin=true WHERE id=$1 AND organization_id=$2`, target, q.org); err != nil {
				return reply{}, err
			}
		}
		return reply{status: 200, resource: target, version: 1, body: humanDoc(target, q.org, name, active, true)}, nil
	}
	if orgAdmin {
		if active {
			if err := requireRemainingOrgAdmin(q, target); err != nil {
				return reply{}, err
			}
		}
		if _, err := q.tx.Exec(q.http.Context(), `UPDATE human_users SET is_org_admin=false WHERE id=$1 AND organization_id=$2`, target, q.org); err != nil {
			return reply{}, err
		}
	}
	return reply{status: 200, resource: target, version: 1, body: humanDoc(target, q.org, name, active, false)}, nil
}

func requireRemainingOrgAdmin(q *request, target string) error {
	var others int
	err := q.tx.QueryRow(q.http.Context(), `SELECT count(*) FROM human_users WHERE organization_id=$1 AND is_org_admin AND active AND id<>$2`, q.org, target).Scan(&others)
	if err != nil {
		return err
	}
	if others < 1 {
		return fail(409, "LAST_ORG_ADMIN", "At least one active organization administrator must remain.")
	}
	return nil
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
		var total int
		if e := q.tx.QueryRow(q.http.Context(), `SELECT count(*) FROM (SELECT id FROM tasks WHERE project_id=$1 AND status NOT IN ('DONE','CANCELED') UNION ALL SELECT id FROM task_runs WHERE project_id=$1 AND status='RUNNING' UNION ALL SELECT id FROM tool_invocations WHERE project_id=$1 AND status IN ('AWAITING_APPROVAL','READY','RUNNING','UNKNOWN')) blockers`, q.project).Scan(&total); e != nil {
			return reply{}, e
		}
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
			prefix := "Finish or cancel tasks and reconcile operations first (up to 20): "
			if total > len(ids) {
				prefix = "Finish or cancel tasks and reconcile operations first (showing " + strconv.Itoa(len(ids)) + " of " + strconv.Itoa(total) + "): "
			}
			return reply{}, fail(409, "ARCHIVE_BLOCKED", prefix+strings.Join(ids, ", "))
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
	return entity(201, membershipDoc(textValue(q.body, "user_id"), q.org, q.project, name, roles, true, true, 1)), nil
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

func revokeDelegatedSessionsEverywhere(q *request, human string) error {
	rows, err := q.tx.Query(q.http.Context(), `UPDATE agent_sessions SET status='REVOKED',version=version+1 WHERE delegated_by_user_id=$1 AND status='ACTIVE' RETURNING id,version,project_id`, human)
	if err != nil {
		return err
	}
	type revoked struct {
		id, project string
		version     int64
	}
	items := []revoked{}
	for rows.Next() {
		var r revoked
		if err = rows.Scan(&r.id, &r.version, &r.project); err != nil {
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
	saved := q.project
	for _, r := range items {
		q.project = r.project
		if err = emitEvent(q, "SESSION_REVOKED", r.id, r.version, Object{"session_id": r.id, "revoked_by_user_id": q.user}); err != nil {
			q.project = saved
			return err
		}
	}
	q.project = saved
	return nil
}

// organizationAudit serves the organization-management journal
// (membership/session/denial actions in organization_audit). It accepts the
// filters this table supports — actor (actor_id), action, and from/to
// (recorded_at); the task and project filters apply only to the execution
// journal (see organizationExecutionAudit) and are ignored here.
func organizationAudit(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	f := &auditFilter{}
	f.bind("organization_id=$%d", q.org)
	f.bind("id>$%d", cursor)
	query := q.http.URL.Query()
	if v := query.Get("actor"); v != "" {
		f.bind("actor_id=$%d", v)
	}
	if v := query.Get("action"); v != "" {
		f.bind("action=$%d", v)
	}
	if v := query.Get("from"); v != "" {
		t, perr := parseAuditTime(v, false)
		if perr != nil {
			return reply{}, perr
		}
		f.bind("recorded_at>=$%d", t)
	}
	if v := query.Get("to"); v != "" {
		t, perr := parseAuditTime(v, true)
		if perr != nil {
			return reply{}, perr
		}
		f.bind("recorded_at<=$%d", t)
	}
	limitArg := len(f.args) + 1
	f.args = append(f.args, limit+1)
	sql := `SELECT id,actor_id,action,resource_id,result,reason,trace_id,recorded_at FROM organization_audit WHERE ` + strings.Join(f.where, " AND ") + fmt.Sprintf(" ORDER BY id LIMIT $%d", limitArg)
	rows, err := q.tx.Query(q.http.Context(), sql, f.args...)
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

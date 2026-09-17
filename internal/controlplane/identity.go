package controlplane

import (
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

func me(q *request) (reply, error) {
	var name string
	err := q.tx.QueryRow(q.http.Context(), `SELECT display_name FROM human_users WHERE id=$1`, q.user).Scan(&name)
	return reply{status: 200, body: Object{"id": q.user, "organization_id": q.org, "display_name": name, "kind": "HUMAN"}}, err
}
func projects(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT p.id,p.name,m.roles,p.status,p.version FROM projects p JOIN memberships m ON m.project_id=p.id WHERE p.organization_id=$1 AND m.user_id=$2 AND m.active AND p.id>$3 ORDER BY p.id LIMIT $4`, q.org, q.user, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, name string
		var roles []string
		var status string
		var version int64
		if err = rows.Scan(&id, &name, &roles, &status, &version); err != nil {
			return reply{}, err
		}
		items = append(items, Object{"id": id, "organization_id": q.org, "name": name, "roles": roles, "status": status, "version": version})
	}
	return page(q.http, items, limit), rows.Err()
}
func members(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT m.user_id,u.display_name,m.roles,m.active AND u.active,m.version FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id>$2 ORDER BY m.user_id LIMIT $3`, q.project, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, name string
		var roles []string
		var active bool
		var version int64
		if err = rows.Scan(&id, &name, &roles, &active, &version); err != nil {
			return reply{}, err
		}
		items = append(items, Object{"id": id, "organization_id": q.org, "project_id": q.project, "display_name": name, "roles": roles, "active": active, "version": version})
	}
	return page(q.http, items, limit), rows.Err()
}
func changeMember(q *request) (reply, error) {
	target := q.http.PathValue("user")
	var oldRoles []string
	var version int64
	var active bool
	var name string
	err := q.tx.QueryRow(q.http.Context(), `SELECT m.roles,m.version,m.active,u.display_name FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2`, q.project, target).Scan(&oldRoles, &version, &active, &name)
	if err == pgx.ErrNoRows {
		return reply{}, fail(404, "NOT_FOUND", "Provisioned member not found.")
	}
	if err != nil {
		return reply{}, err
	}
	if err = match(q, version); err != nil {
		return reply{}, err
	}
	roles := []string{}
	for _, r := range q.body["roles"].([]any) {
		roles = append(roles, r.(string))
	}
	if active && hasRole(oldRoles, "ADMIN") && (!q.body["active"].(bool) || !hasRole(roles, "ADMIN")) {
		var count int
		err = q.tx.QueryRow(q.http.Context(), `SELECT count(*) FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.active AND u.active AND 'ADMIN'=ANY(m.roles)`, q.project).Scan(&count)
		if err != nil {
			return reply{}, err
		}
		if count < 2 {
			return reply{}, fail(409, "LAST_ADMIN", "At least one active human administrator must remain.")
		}
	}
	_, err = q.tx.Exec(q.http.Context(), `UPDATE memberships SET roles=$1,active=$2,version=version+1 WHERE project_id=$3 AND user_id=$4`, roles, q.body["active"], q.project, target)
	if err == nil && q.body["active"] == false {
		err = revokeManagedSessions(q, target)
	}
	return entity(200, Object{"id": target, "organization_id": q.org, "project_id": q.project, "display_name": name, "roles": roles, "active": q.body["active"], "version": version + 1}), err
}
func listAudit(q *request) (reply, error) { return executionAudit(q) }
func publishedEvent(q *request, version, parent Object) error {
	id := newID("event")
	event := Object{"specversion": "1.0", "id": id, "source": "urn:accp:control-plane", "type": "io.accp.CONTEXT_PUBLISHED.v1", "subject": "contexts/" + textValue(parent, "id"), "time": now(), "datacontenttype": "application/json", "data": Object{
		"organization_id": q.org, "project_id": q.project, "aggregate_id": parent["id"], "aggregate_version": parent["version"], "correlation_id": q.trace, "causation_id": q.trace,
		"context_id": parent["id"], "context_version_id": version["id"], "published_by_user_id": q.user,
	}}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO outbox_events(id,project_id,organization_id,event) VALUES($1,$2,$3,$4)`, id, q.project, q.org, data)
	return err
}

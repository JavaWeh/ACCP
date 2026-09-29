package controlplane

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Task cursors bind the page position to the active filters. A cursor from a
// different search must never silently skip rows in a new result set.
func listTasks(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	params := q.http.URL.Query()
	term := strings.TrimSpace(params.Get("q"))
	owner := params.Get("owner")
	status := params.Get("status")
	archived := params.Get("archived")
	since := params.Get("updated_after")
	if archived != "" && archived != "true" && archived != "false" {
		return reply{}, fail(400, "INVALID_FILTER", "archived must be true or false.")
	}
	if len(term) > 200 || len(owner) > 128 || len(status) > 32 || len(since) > 64 {
		return reply{}, fail(400, "INVALID_FILTER", "Task filters are too long.")
	}
	searchPattern := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(term)
	var updated any
	if since != "" {
		updated, err = time.Parse(time.RFC3339Nano, since)
		if err != nil {
			return reply{}, fail(400, "INVALID_FILTER", "updated_after must be an RFC3339 timestamp.")
		}
	}
	params.Del("cursor")
	params.Del("limit")
	filter := params.Encode()
	if cursor != "" {
		data, _ := base64.RawURLEncoding.DecodeString(q.http.URL.Query().Get("cursor"))
		var previous struct{ Filter string }
		if json.Unmarshal(data, &previous) != nil || previous.Filter != filter {
			return reply{}, fail(400, "INVALID_CURSOR", "Start a new page when task filters change.")
		}
	}
	query := `SELECT document FROM tasks WHERE project_id=$1 AND organization_id=$2 AND id>$3`
	if archived == "true" {
		query += ` AND document->>'archived'='true'`
	} else {
		query += ` AND coalesce(document->>'archived','false')='false'`
	}
	args := []any{q.project, q.org, cursor}
	if owner != "" {
		args = append(args, owner)
		query += fmt.Sprintf(` AND owner_user_id=$%d`, len(args))
	}
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(` AND document->>'status'=$%d`, len(args))
	}
	if searchPattern != "" {
		args = append(args, searchPattern)
		query += fmt.Sprintf(` AND lower(coalesce(document->>'title','') || ' ' || coalesce(document->>'objective','')) LIKE '%%' || lower($%d) || '%%' ESCAPE '\'`, len(args))
	}
	if updated != nil {
		args = append(args, updated)
		query += fmt.Sprintf(` AND (document->>'updated_at')::timestamptz>$%d::timestamptz`, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(` ORDER BY id LIMIT $%d`, len(args))
	rows, err := q.tx.Query(q.http.Context(), query, args...)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data); err != nil {
			return reply{}, err
		}
		var doc Object
		if err = json.Unmarshal(data, &doc); err != nil {
			return reply{}, err
		}
		items = append(items, doc)
	}
	if err = rows.Err(); err != nil {
		return reply{}, err
	}
	result := Object{"items": items, "next_cursor": nil}
	if len(items) > limit {
		result["items"] = items[:limit]
		data, _ := json.Marshal(struct{ Path, ID, Filter string }{q.http.URL.Path, textValue(items[limit-1], "id"), filter})
		result["next_cursor"] = base64.RawURLEncoding.EncodeToString(data)
	}
	return reply{status: 200, body: result}, nil
}

func projectWorkbench(q *request) (reply, error) {
	var mine, review, attention, approvals int64
	err := q.tx.QueryRow(q.http.Context(), `SELECT count(*),
		count(*) FILTER (WHERE document->>'status'='IN_REVIEW'),
		count(*) FILTER (WHERE document->>'status' IN ('BLOCKED','FAILED'))
		FROM tasks WHERE project_id=$1 AND organization_id=$2 AND owner_user_id=$3 AND coalesce(document->>'archived','false')='false'`, q.project, q.org, q.user).Scan(&mine, &review, &attention)
	if err != nil {
		return reply{}, err
	}
	if hasRole(q.roles, "REVIEWER") || hasRole(q.roles, "ADMIN") {
		err = q.tx.QueryRow(q.http.Context(), `SELECT count(*) FROM approvals WHERE project_id=$1 AND organization_id=$2 AND document->>'status'='PENDING'`, q.project, q.org).Scan(&approvals)
		if err != nil {
			return reply{}, err
		}
	}
	actions, err := workbenchTasks(q, true)
	if err != nil {
		return reply{}, err
	}
	recent, err := workbenchTasks(q, false)
	if err != nil {
		return reply{}, err
	}
	return reply{status: 200, body: Object{
		"mine": mine, "review": review, "attention": attention,
		"approvals": approvals, "action_tasks": actions,
		"recent_tasks": recent, "checked_at": now(),
	}}, nil
}

func workbenchTasks(q *request, actions bool) ([]Object, error) {
	sql := `SELECT document FROM tasks WHERE project_id=$1 AND organization_id=$2 AND coalesce(document->>'archived','false')='false'`
	args := []any{q.project, q.org}
	if actions {
		sql += ` AND owner_user_id=$3 AND document->>'status' IN ('IN_REVIEW','BLOCKED','FAILED')`
		args = append(args, q.user)
	}
	rows, err := q.tx.Query(q.http.Context(), sql+` ORDER BY document->>'updated_at' DESC, id DESC LIMIT 6`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		var doc Object
		if err = json.Unmarshal(data, &doc); err != nil {
			return nil, err
		}
		items = append(items, doc)
	}
	return items, rows.Err()
}

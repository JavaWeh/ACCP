package controlplane

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type taskCursor struct {
	Path   string
	ID     string
	V      string `json:",omitempty"`
	Filter string
}

// Task cursors bind the page position to the active filters. A cursor from a
// different search must never silently skip rows in a new result set.
func listTasks(q *request) (reply, error) {
	limit, cursorID, err := pageParams(q.http)
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
	sortField, order, sorted, err := parseTaskListSort(params)
	if err != nil {
		return reply{}, err
	}
	filter := taskListFingerprint(params, sortField, order, sorted)
	cursorV := ""
	if params.Get("cursor") != "" {
		previous, err := decodeTaskCursor(params.Get("cursor"), q.http.URL.Path)
		if err != nil {
			return reply{}, err
		}
		if previous.Filter != filter {
			return reply{}, fail(400, "INVALID_CURSOR", "Start a new page when task filters change.")
		}
		if sorted {
			if previous.V == "" {
				return reply{}, fail(400, "INVALID_CURSOR", "The cursor must belong to this collection.")
			}
			cursorV = previous.V
		}
		cursorID = previous.ID
	}

	query := `SELECT document FROM tasks WHERE project_id=$1 AND organization_id=$2`
	args := []any{q.project, q.org}
	if sorted {
		sortExpr := taskSortExpression(sortField)
		if cursorID != "" {
			var key any
			key, err = parseTaskCursorValue(sortField, cursorV)
			if err != nil {
				return reply{}, err
			}
			args = append(args, key, cursorID)
			query += ` AND ` + taskKeysetClause(sortExpr, order == "asc", len(args)-1, len(args))
		}
	} else {
		args = append(args, cursorID)
		query += ` AND id>$3`
	}
	if archived == "true" {
		query += ` AND document->>'archived'='true'`
	} else {
		query += ` AND coalesce(document->>'archived','false')='false'`
	}
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
	if sorted {
		dir := "ASC"
		if order == "desc" {
			dir = "DESC"
		}
		query += fmt.Sprintf(` ORDER BY %s %s, id %s LIMIT $%d`, taskSortExpression(sortField), dir, dir, len(args))
	} else {
		query += fmt.Sprintf(` ORDER BY id LIMIT $%d`, len(args))
	}
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
		last := items[limit-1]
		next := taskCursor{Path: q.http.URL.Path, ID: textValue(last, "id"), Filter: filter}
		if sorted {
			next.V = taskSortCursorValue(sortField, last)
		}
		result["next_cursor"] = encodeTaskCursor(next)
	}
	return reply{status: 200, body: result}, nil
}

func parseTaskListSort(params url.Values) (sortField, order string, sorted bool, err error) {
	hasSort := params.Has("sort")
	hasOrder := params.Has("order")
	if hasOrder && !hasSort {
		return "", "", false, fail(400, "INVALID_ORDER", "order requires sort.")
	}
	if !hasSort {
		return "", "", false, nil
	}
	sortField = params.Get("sort")
	if sortField != "updated_at" && sortField != "title" {
		return "", "", false, fail(400, "INVALID_SORT", "sort must be updated_at or title.")
	}
	if hasOrder {
		order = params.Get("order")
		if order != "asc" && order != "desc" {
			return "", "", false, fail(400, "INVALID_ORDER", "order must be asc or desc.")
		}
	} else if sortField == "updated_at" {
		order = "desc"
	} else {
		order = "asc"
	}
	return sortField, order, true, nil
}

func taskListFingerprint(params url.Values, sortField, order string, sorted bool) string {
	values := cloneURLValues(params)
	values.Del("cursor")
	values.Del("limit")
	if sorted {
		values.Set("sort", sortField)
		values.Set("order", order)
	} else {
		values.Del("sort")
		values.Del("order")
	}
	return values.Encode()
}

func cloneURLValues(in url.Values) url.Values {
	out := make(url.Values, len(in))
	for key, values := range in {
		copied := make([]string, len(values))
		copy(copied, values)
		out[key] = copied
	}
	return out
}

func taskSortExpression(sortField string) string {
	switch sortField {
	case "updated_at":
		return `(document->>'updated_at')::timestamptz`
	case "title":
		return `coalesce(document->>'title','')`
	default:
		return ""
	}
}

func taskKeysetClause(sortExpr string, asc bool, vArg, idArg int) string {
	if asc {
		return fmt.Sprintf(`(%s > $%d OR (%s = $%d AND id > $%d))`, sortExpr, vArg, sortExpr, vArg, idArg)
	}
	return fmt.Sprintf(`(%s < $%d OR (%s = $%d AND id < $%d))`, sortExpr, vArg, sortExpr, vArg, idArg)
}

func parseTaskCursorValue(sortField, raw string) (any, error) {
	if sortField == "title" {
		return raw, nil
	}
	value, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		value, err = time.Parse(time.RFC3339, raw)
	}
	if err != nil {
		return nil, fail(400, "INVALID_CURSOR", "The cursor must belong to this collection.")
	}
	return value, nil
}

func taskSortCursorValue(sortField string, item Object) string {
	if sortField == "title" {
		return textValue(item, "title")
	}
	return textValue(item, "updated_at")
}

func encodeTaskCursor(cursor taskCursor) string {
	data, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(data)
}

func decodeTaskCursor(raw, path string) (taskCursor, error) {
	data, err := base64.RawURLEncoding.DecodeString(raw)
	var cursor taskCursor
	if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Path != path || cursor.ID == "" || len(cursor.ID) > 128 {
		return taskCursor{}, fail(400, "INVALID_CURSOR", "The cursor must belong to this collection.")
	}
	return cursor, nil
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

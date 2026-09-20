package controlplane

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type resourceCursor struct {
	Path   string `json:"path"`
	Query  string `json:"query"`
	Value  string `json:"value"`
	ID     string `json:"id"`
	Issued int64  `json:"issued"`
}

func filteredResources(q *request, table, filter string) (reply, error) {
	if q.server.signer == nil {
		return reply{}, fail(503, "CURSOR_UNAVAILABLE", "Configure a signing key for filtered pagination.")
	}
	query := q.http.URL.Query()
	normalized := url.Values{}
	for _, key := range []string{"search", "status", "owner", "archived", "sort"} {
		if len(query[key]) > 1 {
			return reply{}, fail(400, "INVALID_FILTER", "Repeated filters are not supported.")
		}
		if value := query.Get(key); value != "" {
			normalized.Set(key, value)
		}
	}
	if len(query.Get("search")) > 256 {
		return reply{}, fail(400, "INVALID_FILTER", "Search is limited to 256 bytes.")
	}
	sort := query.Get("sort")
	if sort == "" {
		sort = "id"
	}
	order := "id"
	direction := ">"
	sqlDirection := "ASC"
	switch sort {
	case "id":
	case "title":
		order = "coalesce(document->>'title',document->>'name','')"
	case "updated", "-updated":
		order = "coalesce(document->>'updated_at',document->>'created_at',document->>'occurred_at','')"
	case "-attempt":
		if table != "task_runs" {
			return reply{}, fail(400, "INVALID_SORT", "Attempt ordering is supported only for Runs.")
		}
		order = "lpad(document->>'attempt',20,'0')"
	default:
		return reply{}, fail(400, "INVALID_SORT", "Use id, title, updated or -updated.")
	}
	if sort == "-updated" || sort == "-attempt" {
		direction = "<"
		sqlDirection = "DESC"
	}
	limit := 25
	if query.Get("limit") != "" {
		n, err := strconv.Atoi(query.Get("limit"))
		if err != nil || n < 1 || n > 100 {
			return reply{}, fail(400, "INVALID_PAGE", "limit must be 1 through 100.")
		}
		limit = n
	}
	cursor := resourceCursor{Path: q.http.URL.Path, Query: normalized.Encode(), Issued: time.Now().Unix()}
	hasCursor := query.Get("cursor") != ""
	if hasCursor {
		raw, err := q.server.signer.Open("resource-cursor", query.Get("cursor"))
		var c resourceCursor
		if err != nil || json.Unmarshal([]byte(raw), &c) != nil || c.Path != cursor.Path || c.Query != cursor.Query || c.ID == "" || c.Issued > time.Now().Unix()+60 || c.Issued < time.Now().Add(-24*time.Hour).Unix() {
			return reply{}, fail(400, "INVALID_CURSOR", "Filters or cursor changed; start a new page.")
		}
		cursor = c
	}
	args := []any{q.project, q.org}
	sql := `SELECT document,` + order + ` FROM ` + table + ` WHERE project_id=$1 AND organization_id=$2`
	bind := func(value any) string { args = append(args, value); return fmt.Sprintf("$%d", len(args)) }
	if filter != "" {
		sql += ` AND ` + filter + `=` + bind(q.http.PathValue("id"))
	}
	if value := query.Get("status"); value != "" {
		sql += ` AND document->>'status'=` + bind(value)
	}
	if value := query.Get("owner"); value != "" {
		sql += ` AND document->>'owner_user_id'=` + bind(value)
	}
	if value := query.Get("archived"); value != "" {
		if table != "tasks" || (value != "true" && value != "false" && value != "all") {
			return reply{}, fail(400, "INVALID_FILTER", "archived supports true, false or all on tasks.")
		}
		if value != "all" {
			sql += ` AND archived=` + bind(value == "true")
		}
	}
	if value := query.Get("search"); value != "" {
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
		expression := `(coalesce(document->>'title',document->>'name','') || ' ' || coalesce(document->>'objective',''))`
		if table == "audit_documents" {
			expression = `(coalesce(document->>'action','') || ' ' || coalesce(document->>'accountable_user_id','') || ' ' || coalesce(document->>'task_id','') || ' ' || coalesce(document->>'resource_id',''))`
		}
		sql += ` AND ` + expression + ` ILIKE ` + bind("%"+escaped+"%")
	}
	if hasCursor {
		sql += ` AND (` + order + `,id) ` + direction + ` (` + bind(cursor.Value) + `,` + bind(cursor.ID) + `)`
	}
	sql += ` ORDER BY ` + order + ` ` + sqlDirection + `,id ` + sqlDirection + ` LIMIT ` + bind(limit+1)
	rows, err := q.tx.Query(q.http.Context(), sql, args...)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	next := ""
	for rows.Next() {
		var raw []byte
		var value string
		if err = rows.Scan(&raw, &value); err != nil {
			return reply{}, err
		}
		if len(items) == limit {
			encoded, _ := json.Marshal(cursor)
			next = q.server.signer.Seal("resource-cursor", string(encoded))
			break
		}
		var doc Object
		if err = json.Unmarshal(raw, &doc); err != nil {
			return reply{}, err
		}
		items = append(items, doc)
		cursor.Value = value
		cursor.ID = textValue(doc, "id")
	}
	if err = rows.Err(); err != nil {
		return reply{}, err
	}
	var nextValue any
	if next != "" {
		nextValue = next
	}
	return reply{status: 200, body: Object{"items": items, "next_cursor": nextValue}}, nil
}

package controlplane

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/jackc/pgx/v5"
)

func readDocument(q *request, table, id string) (Object, error) {
	var data []byte
	err := q.tx.QueryRow(q.http.Context(), `SELECT document FROM `+table+` WHERE id=$1 AND project_id=$2 AND organization_id=$3`, id, q.project, q.org).Scan(&data)
	if err == pgx.ErrNoRows {
		return nil, fail(404, "NOT_FOUND", "Resource not found.")
	}
	if err != nil {
		return nil, err
	}
	var doc Object
	err = json.Unmarshal(data, &doc)
	return doc, err
}
func getResource(table string) func(*request) (reply, error) {
	return func(q *request) (reply, error) {
		doc, err := readDocument(q, table, q.http.PathValue("id"))
		if err != nil {
			return reply{}, err
		}
		return entity(200, doc), nil
	}
}
func listResources(table, filter string) func(*request) (reply, error) {
	return func(q *request) (reply, error) {
		limit, cursor, err := pageParams(q.http)
		if err != nil {
			return reply{}, err
		}
		sql := `SELECT document FROM ` + table + ` WHERE project_id=$1 AND organization_id=$2 AND id>$3`
		args := []any{q.project, q.org, cursor, limit + 1}
		if filter != "" {
			sql += ` AND ` + filter + `=$5`
			args = append(args, q.http.PathValue("id"))
		}
		rows, err := q.tx.Query(q.http.Context(), sql+` ORDER BY id LIMIT $4`, args...)
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
			var obj Object
			if err = json.Unmarshal(data, &obj); err != nil {
				return reply{}, err
			}
			items = append(items, obj)
		}
		return page(q.http, items, limit), rows.Err()
	}
}
func createTask(q *request) (reply, error) {
	if ext, ok := q.body["extensions"].(map[string]any); ok && len(ext) > 0 {
		return reply{}, fail(422, "UNSUPPORTED_EXTENSION", "M1 has no registered Task extensions.")
	}
	var valid bool
	err := q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.organization_id=$2 AND m.user_id=$3 AND m.active AND u.active)`, q.project, q.org, q.body["owner_user_id"]).Scan(&valid)
	if err != nil {
		return reply{}, err
	}
	if !valid {
		return reply{}, fail(422, "INVALID_OWNER", "Owner must be an active human member of this project.")
	}
	err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM repositories WHERE id=$1 AND project_id=$2 AND organization_id=$3)`, q.body["repository_id"], q.project, q.org).Scan(&valid)
	if err != nil {
		return reply{}, err
	}
	if !valid {
		return reply{}, fail(422, "INVALID_REPOSITORY", "Repository must belong to this project.")
	}
	versions := q.body["context_version_ids"].([]any)
	contextIDs := map[string]bool{}
	docs := []Object{}
	for _, id := range versions {
		doc, err := readDocument(q, "context_versions", id.(string))
		if err != nil {
			return reply{}, fail(422, "INVALID_CONTEXT", "Each Context version must belong to this project.")
		}
		contextID := textValue(doc, "context_id")
		if contextIDs[contextID] {
			return reply{}, fail(422, "CONTEXT_CONFLICT", "Select only one version of each Context.")
		}
		contextIDs[contextID] = true
		docs = append(docs, doc)
	}
	doc := q.body
	delete(doc, "extensions")
	doc["id"] = newID("task")
	doc["organization_id"] = q.org
	doc["project_id"] = q.project
	doc["status"] = "DRAFT"
	doc["version"] = int64(1)
	doc["created_at"] = now()
	doc["updated_at"] = doc["created_at"]
	data, err := json.Marshal(doc)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO tasks(id,project_id,organization_id,owner_user_id,repository_id,document,status) VALUES($1,$2,$3,$4,$5,$6,'DRAFT')`, doc["id"], q.project, q.org, doc["owner_user_id"], doc["repository_id"], data)
	if err != nil {
		return reply{}, err
	}
	for _, v := range docs {
		_, err = q.tx.Exec(q.http.Context(), `INSERT INTO task_contexts(task_id,context_id,version_id,project_id,organization_id) VALUES($1,$2,$3,$4,$5)`, doc["id"], v["context_id"], v["id"], q.project, q.org)
		if err != nil {
			return reply{}, err
		}
	}
	return entity(201, doc), nil
}
func commandTask(q *request) (reply, error) {
	doc, err := readDocument(q, "tasks", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	if doc["owner_user_id"] != q.user && !hasRole(q.roles, "ADMIN") {
		return reply{}, fail(403, "OWNER_REQUIRED", "Only the human Owner or project administrator may issue Task commands.")
	}
	if err = match(q, number(doc, "version")); err != nil {
		return reply{}, err
	}
	state := textValue(doc, "status")
	switch q.body["command"] {
	case "SUBMIT":
		if state != "DRAFT" && state != "BLOCKED" {
			return reply{}, fail(409, "INVALID_TRANSITION", "Only DRAFT or BLOCKED tasks can be submitted in M1.")
		}
		var ready bool
		err = q.tx.QueryRow(q.http.Context(), `SELECT NOT EXISTS(SELECT 1 FROM task_contexts tc JOIN context_versions v ON v.id=tc.version_id WHERE tc.task_id=$1 AND v.status<>'PUBLISHED') AND EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id WHERE m.project_id=$2 AND m.user_id=$3 AND m.active AND u.active)`, doc["id"], q.project, doc["owner_user_id"]).Scan(&ready)
		if err != nil {
			return reply{}, err
		}
		doc["status"] = "BLOCKED"
		if ready {
			doc["status"] = "READY"
		}
	case "CANCEL":
		if state == "CANCELED" {
			return reply{}, fail(409, "INVALID_TRANSITION", "Task is already canceled.")
		}
		doc["status"] = "CANCELED"
	default:
		return reply{}, fail(501, "NOT_IMPLEMENTED", "TaskRun execution and RETRY are scheduled for M2.")
	}
	doc["version"] = number(doc, "version") + 1
	doc["updated_at"] = now()
	data, err := json.Marshal(doc)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(q.http.Context(), `UPDATE tasks SET document=$1,status=$2,version=$3 WHERE id=$4 AND project_id=$5`, data, doc["status"], doc["version"], doc["id"], q.project)
	return entity(200, doc), err
}
func createContext(q *request) (reply, error) {
	source := q.body["source"].(map[string]any)
	if source["kind"] != "ACCP" {
		return reply{}, fail(422, "UNSUPPORTED_SOURCE", "M1 supports ACCP-managed content; external source verification is deferred.")
	}
	doc := q.body
	doc["id"] = newID("ctx")
	doc["organization_id"] = q.org
	doc["project_id"] = q.project
	doc["version"] = int64(1)
	data, err := json.Marshal(doc)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO contexts(id,project_id,organization_id,document) VALUES($1,$2,$3,$4)`, doc["id"], q.project, q.org, data)
	return entity(201, doc), err
}
func uploadContent(q *request) (reply, error) {
	content := textValue(q.body, "content")
	if len(content) > 262144 || strings.ContainsRune(content, 0) {
		return reply{}, fail(422, "INVALID_CONTENT", "UTF-8 text must be at most 256 KiB and contain no NUL bytes.")
	}
	id := newID("content")
	digest := auth.Digest(content)
	_, err := q.tx.Exec(q.http.Context(), `INSERT INTO context_contents(id,project_id,organization_id,content,media_type,digest) VALUES($1,$2,$3,$4,$5,$6)`, id, q.project, q.org, content, q.body["media_type"], digest)
	return reply{status: 201, resource: id, version: 1, body: Object{"id": id, "organization_id": q.org, "project_id": q.project, "content_uri": "urn:accp:content:" + id, "content_digest": digest, "media_type": q.body["media_type"]}}, err
}
func getContent(q *request) (reply, error) {
	var content, kind, digest string
	err := q.tx.QueryRow(q.http.Context(), `SELECT content,media_type,digest FROM context_contents WHERE id=$1 AND project_id=$2 AND organization_id=$3`, q.http.PathValue("id"), q.project, q.org).Scan(&content, &kind, &digest)
	if err != nil {
		return reply{}, err
	}
	return reply{status: 200, body: Object{"id": q.http.PathValue("id"), "organization_id": q.org, "project_id": q.project, "content": content, "content_uri": "urn:accp:content:" + q.http.PathValue("id"), "media_type": kind, "content_digest": digest}}, nil
}
func createVersion(q *request) (reply, error) {
	parent, err := readDocument(q, "contexts", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	if err = match(q, number(parent, "version")); err != nil {
		return reply{}, err
	}
	uri := textValue(q.body, "content_uri")
	if !strings.HasPrefix(uri, "urn:accp:content:") {
		return reply{}, fail(422, "UNSUPPORTED_CONTENT_URI", "Upload content before registering its version; M1 does not fetch remote URLs.")
	}
	contentID := strings.TrimPrefix(uri, "urn:accp:content:")
	var digest, kind string
	err = q.tx.QueryRow(q.http.Context(), `SELECT digest,media_type FROM context_contents WHERE id=$1 AND project_id=$2 AND organization_id=$3`, contentID, q.project, q.org).Scan(&digest, &kind)
	if err == pgx.ErrNoRows {
		return reply{}, fail(422, "INVALID_CONTENT", "Content must belong to this project.")
	}
	if err != nil {
		return reply{}, err
	}
	if digest != q.body["content_digest"] || kind != q.body["media_type"] {
		return reply{}, fail(422, "CONTENT_MISMATCH", "Content digest or media type does not match stored bytes.")
	}
	doc := q.body
	doc["id"] = newID("cv")
	doc["context_id"] = parent["id"]
	doc["organization_id"] = q.org
	doc["project_id"] = q.project
	doc["status"] = "CANDIDATE"
	doc["version"] = int64(1)
	doc["created_by"] = Object{"kind": "HUMAN", "user_id": q.user}
	data, err := json.Marshal(doc)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO context_versions(id,context_id,content_id,project_id,organization_id,document,status) VALUES($1,$2,$3,$4,$5,$6,'CANDIDATE')`, doc["id"], parent["id"], contentID, q.project, q.org, data)
	if err != nil {
		return reply{}, err
	}
	parent["version"] = number(parent, "version") + 1
	data, err = json.Marshal(parent)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(q.http.Context(), `UPDATE contexts SET document=$1,version=$2 WHERE id=$3`, data, parent["version"], parent["id"])
	return entity(201, doc), err
}
func versionDocument(q *request) (Object, error) {
	doc, err := readDocument(q, "context_versions", q.http.PathValue("version"))
	if err != nil {
		return nil, err
	}
	if doc["context_id"] != q.http.PathValue("id") {
		return nil, fail(404, "NOT_FOUND", "Context version not found.")
	}
	return doc, nil
}
func getVersion(q *request) (reply, error) {
	doc, err := versionDocument(q)
	if err != nil {
		return reply{}, err
	}
	return entity(200, doc), nil
}
func publishVersion(q *request) (reply, error) {
	doc, err := versionDocument(q)
	if err != nil {
		return reply{}, err
	}
	if err = match(q, number(doc, "version")); err != nil {
		return reply{}, err
	}
	if doc["status"] != "CANDIDATE" {
		return reply{}, fail(409, "ALREADY_PUBLISHED", "Published versions cannot be published again.")
	}
	doc["status"] = "PUBLISHED"
	doc["version"] = number(doc, "version") + 1
	doc["published_by_user_id"] = q.user
	doc["published_at"] = now()
	data, err := json.Marshal(doc)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(q.http.Context(), `UPDATE context_versions SET document=$1,status='PUBLISHED',version=$2 WHERE id=$3`, data, doc["version"], doc["id"])
	if err != nil {
		return reply{}, err
	}
	parent, err := readDocument(q, "contexts", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	parent["current_published_version_id"] = doc["id"]
	parent["version"] = number(parent, "version") + 1
	data, err = json.Marshal(parent)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(q.http.Context(), `UPDATE contexts SET document=$1,version=$2 WHERE id=$3`, data, parent["version"], parent["id"])
	if err != nil {
		return reply{}, err
	}
	if err = publishedEvent(q, doc, parent); err != nil {
		return reply{}, err
	}
	return entity(http.StatusOK, doc), nil
}

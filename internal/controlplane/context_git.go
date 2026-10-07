package controlplane

import (
	"encoding/json"
	"strings"

	"github.com/JavaWeh/ACCP/internal/gitprovider"
)

// registeredGitSource binds a document to one of this project's registered
// GitHub repositories. No caller-supplied host or credential reaches the
// provider, and the source path cannot switch repositories at sync time.
func registeredGitSource(q *request, canonical string) (string, string, error) {
	rows, err := q.tx.Query(q.http.Context(), `SELECT document FROM repositories WHERE project_id=$1 AND organization_id=$2`, q.project, q.org)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data); err != nil {
			return "", "", err
		}
		var repository Object
		if err = json.Unmarshal(data, &repository); err != nil {
			return "", "", err
		}
		path, pathErr := gitprovider.SourcePath(canonical, textValue(repository, "url"), textValue(repository, "default_branch"))
		if pathErr == nil {
			return textValue(repository, "url"), path, nil
		}
	}
	if err = rows.Err(); err != nil {
		return "", "", err
	}
	return "", "", fail(422, "INVALID_GIT_SOURCE", "Use a document URL in a registered GitHub repository's default branch.")
}

func syncGitContext(q *request) (reply, error) {
	parent, err := readDocument(q, "contexts", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	if err = match(q, number(parent, "version")); err != nil {
		return reply{}, err
	}
	source, ok := parent["source"].(map[string]any)
	if !ok || source["kind"] != "GIT" {
		return reply{}, fail(409, "INVALID_SOURCE", "This Context does not have a Git source.")
	}
	repository, path, err := registeredGitSource(q, textValue(source, "canonical_uri"))
	if err != nil {
		return reply{}, err
	}
	provider, ok := q.server.options.GitProvider.(gitprovider.FileProvider)
	if !ok {
		if q.server.options.GitProvider != nil {
			return reply{}, fail(503, "GIT_SOURCE_UNAVAILABLE", "The configured Git provider cannot read source files.")
		}
		provider = &gitprovider.GitHub{}
	}
	revision := textValue(q.body, "source_revision")
	var exists bool
	if err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM context_versions WHERE context_id=$1 AND document->>'source_revision'=$2)`, parent["id"], revision).Scan(&exists); err != nil {
		return reply{}, err
	}
	if exists {
		return reply{}, fail(409, "SOURCE_REVISION_EXISTS", "This Git commit is already recorded for the Context.")
	}
	content, digest, err := provider.FetchFile(q.http.Context(), repository, path, revision)
	if err != nil {
		return reply{}, fail(422, "GIT_SOURCE_UNAVAILABLE", "Unable to verify a bounded text file at the selected commit.")
	}
	mediaType := "text/plain"
	if strings.HasSuffix(strings.ToLower(path), ".md") || strings.HasSuffix(strings.ToLower(path), ".markdown") {
		mediaType = "text/markdown"
	}
	contentID := newID("content")
	if _, err = q.tx.Exec(q.http.Context(), `INSERT INTO context_contents(id,project_id,organization_id,content,media_type,digest) VALUES($1,$2,$3,$4,$5,$6)`, contentID, q.project, q.org, content, mediaType, digest); err != nil {
		return reply{}, err
	}
	doc := Object{
		"id": newID("cv"), "context_id": parent["id"], "organization_id": q.org, "project_id": q.project,
		"source_revision": revision, "content_uri": "urn:accp:content:" + contentID,
		"content_digest": digest, "media_type": mediaType, "change_summary": q.body["change_summary"],
		"source_permalink": repository + "/blob/" + revision + "/" + path, "source_verified_at": now(),
		"status": "CANDIDATE", "version": int64(1), "created_by": Object{"kind": "HUMAN", "user_id": q.user},
	}
	data, _ := json.Marshal(doc)
	if _, err = q.tx.Exec(q.http.Context(), `INSERT INTO context_versions(id,context_id,content_id,project_id,organization_id,document,status) VALUES($1,$2,$3,$4,$5,$6,'CANDIDATE')`, doc["id"], parent["id"], contentID, q.project, q.org, data); err != nil {
		return reply{}, err
	}
	parent["version"] = number(parent, "version") + 1
	data, _ = json.Marshal(parent)
	if _, err = q.tx.Exec(q.http.Context(), `UPDATE contexts SET document=$1,version=$2 WHERE id=$3 AND project_id=$4`, data, parent["version"], parent["id"], q.project); err != nil {
		return reply{}, err
	}
	return entity(201, doc), nil
}

func compareContextVersion(q *request) (reply, error) {
	candidate, err := versionDocument(q)
	if err != nil {
		return reply{}, err
	}
	parent, err := readDocument(q, "contexts", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	var after string
	if err = q.tx.QueryRow(q.http.Context(), `SELECT c.content FROM context_versions v JOIN context_contents c ON c.id=v.content_id WHERE v.id=$1 AND v.project_id=$2`, candidate["id"], q.project).Scan(&after); err != nil {
		return reply{}, err
	}
	beforeID := textValue(parent, "current_published_version_id")
	before := ""
	if beforeID != "" {
		if err = q.tx.QueryRow(q.http.Context(), `SELECT c.content FROM context_versions v JOIN context_contents c ON c.id=v.content_id WHERE v.id=$1 AND v.project_id=$2`, beforeID, q.project).Scan(&before); err != nil {
			return reply{}, err
		}
	}
	result := Object{"before_version_id": beforeID, "before_content": before, "after_version_id": candidate["id"], "after_content": after, "changed": before != after, "affected_task_count": int64(0), "affected_tasks": []Object{}}
	if beforeID == "" {
		return reply{status: 200, body: result}, nil
	}
	var count int64
	if err = q.tx.QueryRow(q.http.Context(), `SELECT count(*) FROM task_contexts tc JOIN tasks t ON t.id=tc.task_id WHERE tc.version_id=$1 AND t.project_id=$2 AND t.document->>'status' NOT IN ('DONE','CANCELED')`, beforeID, q.project).Scan(&count); err != nil {
		return reply{}, err
	}
	result["affected_task_count"] = count
	rows, err := q.tx.Query(q.http.Context(), `SELECT t.document FROM task_contexts tc JOIN tasks t ON t.id=tc.task_id WHERE tc.version_id=$1 AND t.project_id=$2 AND t.document->>'status' NOT IN ('DONE','CANCELED') ORDER BY t.id LIMIT 20`, beforeID, q.project)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	tasks := []Object{}
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data); err != nil {
			return reply{}, err
		}
		var task Object
		if err = json.Unmarshal(data, &task); err != nil {
			return reply{}, err
		}
		tasks = append(tasks, Object{"id": task["id"], "title": task["title"], "status": task["status"]})
	}
	if err = rows.Err(); err != nil {
		return reply{}, err
	}
	result["affected_tasks"] = tasks
	return reply{status: 200, body: result}, nil
}

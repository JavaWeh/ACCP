package controlplane

import (
	"encoding/json"
	"net/url"
	"strings"

	"github.com/JavaWeh/ACCP/internal/gitprovider"
	"github.com/jackc/pgx/v5"
)

func (s *Server) gitContextRoutes(routes map[string]operation) {
	routes["POST /api/v1/projects/{id}/git-contexts"] = operation{table: "projects", role: "MEMBER", schema: "GitContextCreate", run: createGitContext}
	routes["POST /api/v1/contexts/{id}/source-sync"] = operation{table: "contexts", role: "MEMBER", schema: "GitContextSync", conditional: true, run: syncGitContext}
	routes["GET /api/v1/contexts/{id}/source"] = operation{table: "contexts", run: getGitSource}
	routes["GET /api/v1/contexts/{id}/versions/{version}/diff"] = operation{table: "contexts", run: contextVersionDiff}
	routes["GET /api/v1/contexts/{id}/versions/{version}/impact"] = operation{table: "contexts", run: contextVersionImpact}
}

func createGitContext(q *request) (reply, error) {
	repo, err := readDocument(q, "repositories", textValue(q.body, "repository_id"))
	if err != nil {
		return reply{}, err
	}
	reference := gitprovider.TextReference{RepositoryURL: textValue(repo, "url"), Ref: textValue(q.body, "ref"), Path: textValue(q.body, "path")}
	if !gitprovider.ValidTextReference(reference) {
		return reply{}, fail(422, "INVALID_GIT_SOURCE", "Use a registered GitHub repository, bounded ref and regular relative path.")
	}
	canonical := strings.TrimSuffix(reference.RepositoryURL, ".git") + "/blob/" + url.PathEscape(reference.Ref) + "/" + strings.Join(escapeSegments(reference.Path), "/")
	doc := Object{"id": newID("ctx"), "project_id": q.project, "organization_id": q.org, "name": q.body["name"], "type": q.body["type"], "source": Object{"kind": "GIT", "canonical_uri": canonical}, "version": int64(1)}
	raw, _ := json.Marshal(doc)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO contexts(id,project_id,organization_id,document) VALUES($1,$2,$3,$4)`, doc["id"], q.project, q.org, raw)
	if err != nil {
		return reply{}, err
	}
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO context_git_sources(context_id,project_id,organization_id,repository_id,path,ref) VALUES($1,$2,$3,$4,$5,$6)`, doc["id"], q.project, q.org, repo["id"], reference.Path, reference.Ref)
	return entity(201, doc), err
}
func escapeSegments(path string) []string {
	parts := strings.Split(path, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return parts
}

func gitSource(q *request) (Object, error) {
	var repository, path, ref string
	err := q.tx.QueryRow(q.http.Context(), `SELECT repository_id,path,ref FROM context_git_sources WHERE context_id=$1 AND project_id=$2 AND organization_id=$3`, q.http.PathValue("id"), q.project, q.org).Scan(&repository, &path, &ref)
	if err == pgx.ErrNoRows {
		return nil, fail(404, "GIT_SOURCE_NOT_FOUND", "This Context has no registered Git source.")
	}
	if err != nil {
		return nil, err
	}
	repo, err := readDocument(q, "repositories", repository)
	if err != nil {
		return nil, err
	}
	return Object{"repository_id": repository, "repository_url": repo["url"], "path": path, "ref": ref}, nil
}
func getGitSource(q *request) (reply, error) {
	source, err := gitSource(q)
	return reply{status: 200, body: source}, err
}

func syncGitContext(q *request) (reply, error) {
	parent, err := readDocument(q, "contexts", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	if err = match(q, number(parent, "version")); err != nil {
		return reply{}, err
	}
	source, err := gitSource(q)
	if err != nil {
		return reply{}, err
	}
	reader, ok := q.server.options.GitProvider.(gitprovider.TextReader)
	if !ok {
		return reply{}, fail(503, "GIT_PROVIDER_UNAVAILABLE", "Configure the Git text provider.")
	}
	ref := textValue(source, "ref")
	if value := textValue(q.body, "ref"); value != "" {
		ref = value
	}
	evidence, err := reader.ReadText(q.http.Context(), gitprovider.TextReference{RepositoryURL: textValue(source, "repository_url"), Path: textValue(source, "path"), Ref: ref})
	if err != nil {
		return reply{}, fail(422, "GIT_SOURCE_UNAVAILABLE", err.Error())
	}
	// Check permissions and actual provider content on every sync, including deduplication.
	var existing string
	err = q.tx.QueryRow(q.http.Context(), `SELECT version_id FROM context_git_versions WHERE context_id=$1 AND content_digest=$2`, parent["id"], evidence.ContentDigest).Scan(&existing)
	if err == nil {
		v, e := readDocument(q, "context_versions", existing)
		return entity(200, v), e
	}
	if err != pgx.ErrNoRows {
		return reply{}, err
	}
	provenance := Object{"kind": "GIT", "repository_id": source["repository_id"], "repository_url": evidence.RepositoryURL, "path": evidence.Path, "ref": evidence.Ref, "commit_sha": evidence.CommitSHA, "blob_sha": evidence.BlobSHA, "content_digest": evidence.ContentDigest}
	contentID := newID("content")
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO context_contents(id,project_id,organization_id,content,media_type,digest) VALUES($1,$2,$3,$4,'text/plain',$5)`, contentID, q.project, q.org, evidence.Content, evidence.ContentDigest)
	if err != nil {
		return reply{}, err
	}
	v := Object{"id": newID("cv"), "context_id": parent["id"], "organization_id": q.org, "project_id": q.project, "source_revision": evidence.CommitSHA, "content_uri": "urn:accp:content:" + contentID, "content_digest": evidence.ContentDigest, "media_type": "text/plain", "change_summary": q.body["reason"], "status": "CANDIDATE", "version": int64(1), "created_by": Object{"kind": "HUMAN", "user_id": q.user}, "git_provenance": provenance}
	raw, _ := json.Marshal(v)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO context_versions(id,context_id,content_id,project_id,organization_id,document,status) VALUES($1,$2,$3,$4,$5,$6,'CANDIDATE')`, v["id"], parent["id"], contentID, q.project, q.org, raw)
	if err != nil {
		return reply{}, err
	}
	raw, _ = json.Marshal(provenance)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO context_git_versions(version_id,context_id,project_id,organization_id,content_digest,provenance) VALUES($1,$2,$3,$4,$5,$6)`, v["id"], parent["id"], q.project, q.org, evidence.ContentDigest, raw)
	if err != nil {
		return reply{}, err
	}
	parent["version"] = number(parent, "version") + 1
	raw, _ = json.Marshal(parent)
	_, err = q.tx.Exec(q.http.Context(), `UPDATE contexts SET version=$1,document=$2 WHERE id=$3`, parent["version"], raw, parent["id"])
	return entity(201, v), err
}

func contextText(q *request, version Object) (string, error) {
	var content string
	err := q.tx.QueryRow(q.http.Context(), `SELECT c.content FROM context_versions v JOIN context_contents c ON c.id=v.content_id WHERE v.id=$1 AND v.project_id=$2 AND v.organization_id=$3`, version["id"], q.project, q.org).Scan(&content)
	return content, err
}
func contextVersionDiff(q *request) (reply, error) {
	candidate, err := versionDocument(q)
	if err != nil {
		return reply{}, err
	}
	parent, err := readDocument(q, "contexts", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	base := q.http.URL.Query().Get("base")
	if base == "" {
		base = textValue(parent, "current_published_version_id")
	}
	before := ""
	var previous any
	if base != "" {
		v, e := readDocument(q, "context_versions", base)
		if e != nil {
			return reply{}, e
		}
		if v["context_id"] != parent["id"] {
			return reply{}, fail(404, "NOT_FOUND", "Base version belongs to another Context.")
		}
		before, err = contextText(q, v)
		if err != nil {
			return reply{}, err
		}
		previous = v
	}
	after, err := contextText(q, candidate)
	return reply{status: 200, body: Object{"before": before, "after": after, "base_version": previous, "candidate_version": candidate}}, err
}
func contextVersionImpact(q *request) (reply, error) {
	v, err := versionDocument(q)
	if err != nil {
		return reply{}, err
	}
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT t.document FROM tasks t JOIN task_contexts c ON c.task_id=t.id WHERE c.context_id=$1 AND c.version_id<>$2 AND t.project_id=$3 AND t.organization_id=$4 AND NOT t.archived AND t.id>$5 ORDER BY t.id LIMIT $6`, v["context_id"], v["id"], q.project, q.org, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			return reply{}, err
		}
		var task Object
		if err = json.Unmarshal(raw, &task); err != nil {
			return reply{}, err
		}
		items = append(items, task)
	}
	return page(q.http, items, limit), rows.Err()
}

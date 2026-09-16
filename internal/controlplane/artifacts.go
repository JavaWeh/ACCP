package controlplane

import (
	"encoding/json"
	"strings"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/jackc/pgx/v5"
)

func uploadArtifactContent(q *request) (reply, error) {
	run, err := activeRun(q, true)
	if err != nil {
		return reply{}, err
	}
	content := textValue(q.body, "content")
	if len(content) > 262144 || strings.ContainsRune(content, 0) {
		return reply{}, fail(422, "INVALID_CONTENT", "UTF-8 text must be at most 256 KiB without NUL bytes.")
	}
	doc := Object{"id": newID("artifactcontent"), "organization_id": q.org, "project_id": q.project, "run_id": run["id"], "content_digest": auth.Digest(content), "media_type": q.body["media_type"]}
	doc["uri"] = "urn:accp:artifact-content:" + textValue(doc, "id")
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO artifact_contents(id,run_id,project_id,organization_id,content,media_type,digest) VALUES($1,$2,$3,$4,$5,$6,$7)`, doc["id"], run["id"], q.project, q.org, content, doc["media_type"], doc["content_digest"])
	return reply{status: 201, body: doc, resource: textValue(doc, "id"), version: 1}, err
}
func registerArtifact(q *request) (reply, error) {
	run, err := activeRun(q, true)
	if err != nil {
		return reply{}, err
	}
	doc := q.body
	verification := "UNVERIFIED"
	var contentID any
	uri := textValue(doc, "uri")
	if strings.HasPrefix(uri, "urn:accp:artifact-content:") {
		id := strings.TrimPrefix(uri, "urn:accp:artifact-content:")
		var digest, media string
		err = q.tx.QueryRow(q.http.Context(), `SELECT digest,media_type FROM artifact_contents WHERE id=$1 AND run_id=$2 AND project_id=$3`, id, run["id"], q.project).Scan(&digest, &media)
		if err == pgx.ErrNoRows {
			return reply{}, fail(422, "INVALID_ARTIFACT_CONTENT", "Upload content in this Run first.")
		}
		if err != nil {
			return reply{}, err
		}
		if doc["content_digest"] != digest || doc["media_type"] != media {
			return reply{}, fail(422, "CONTENT_MISMATCH", "Artifact digest and media type must match stored bytes.")
		}
		// Uploaded text proves bytes, never the existence or state of a Git object.
		if doc["kind"] == "COMMIT" || doc["kind"] == "PULL_REQUEST" {
			return reply{}, fail(422, "EXTERNAL_REFERENCE_REQUIRED", "Git objects require external references and provider verification.")
		}
		contentID = id
		verification = "VERIFIED"
	}
	if parents, ok := doc["parent_artifact_ids"].([]any); ok {
		for _, id := range parents {
			var valid bool
			// Project writes hold the project lock. Cross-Run parents must still
			// match an accepted dependency frozen by the server at claim time.
			err = q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(
				SELECT 1 FROM artifacts a
				WHERE a.id=$1 AND a.project_id=$3 AND a.organization_id=$4
				AND (a.run_id=$2 OR (
					a.acceptance_status='ACCEPTED' AND a.verification_status='VERIFIED'
					AND EXISTS (
						SELECT 1 FROM context_snapshots s,
						jsonb_array_elements(coalesce(s.document->'artifact_refs','[]'::jsonb)) ref
						WHERE s.id=$5 AND s.project_id=$3 AND s.organization_id=$4
						AND ref->>'artifact_id'=a.id
						AND ref->'version'=a.document->'version'
						AND ref->>'content_digest'=a.document->>'content_digest'
						AND ref->>'task_id'=a.document->'provenance'->>'task_id'
					)
				))
			)`, id, run["id"], q.project, q.org, run["context_snapshot_id"]).Scan(&valid)
			if err != nil {
				return reply{}, err
			}
			if !valid {
				return reply{}, fail(422, "INVALID_PARENT", "Parent must belong to this Run or match a verified, accepted dependency in its frozen snapshot.")
			}
		}
	}
	if id := textValue(doc, "context_version_id"); id != "" {
		if _, err = readDocument(q, "context_versions", id); err != nil {
			return reply{}, err
		}
	}
	provenance := Object{"task_run_id": run["id"]}
	for _, k := range []string{"task_id", "session_id", "agent_id", "owner_user_id", "delegated_by_user_id", "context_snapshot_id"} {
		provenance[k] = run[k]
	}
	doc["id"] = newID("artifact")
	doc["organization_id"] = q.org
	doc["project_id"] = q.project
	doc["provenance"] = provenance
	doc["verification_status"] = verification
	doc["acceptance_status"] = "PENDING"
	doc["version"] = int64(1)
	data, _ := json.Marshal(doc)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO artifacts(id,run_id,project_id,organization_id,content_id,document,verification_status,acceptance_status) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING')`, doc["id"], run["id"], q.project, q.org, contentID, data, verification)
	return entity(201, doc), err
}
func artifactAccess(q *request, runID string) error {
	if q.session == nil {
		return nil
	}
	run, err := readDocument(q, "task_runs", runID)
	if err != nil {
		return err
	}
	if run["session_id"] != q.session.ID {
		return fail(404, "NOT_FOUND", "Artifact not found.")
	}
	return nil
}
func getArtifact(q *request) (reply, error) {
	doc, err := readDocument(q, "artifacts", q.http.PathValue("id"))
	if err != nil {
		return reply{}, err
	}
	if err = artifactAccess(q, textValue(doc["provenance"].(map[string]any), "task_run_id")); err != nil {
		return reply{}, err
	}
	return entity(200, doc), nil
}
func getArtifactContent(q *request) (reply, error) {
	var run, content, media, digest string
	err := q.tx.QueryRow(q.http.Context(), `SELECT run_id,content,media_type,digest FROM artifact_contents WHERE id=$1 AND project_id=$2`, q.http.PathValue("id"), q.project).Scan(&run, &content, &media, &digest)
	if err != nil {
		return reply{}, err
	}
	if err = artifactAccess(q, run); err != nil {
		return reply{}, err
	}
	return reply{status: 200, body: Object{"id": q.http.PathValue("id"), "run_id": run, "project_id": q.project, "organization_id": q.org, "content": content, "media_type": media, "content_digest": digest, "uri": "urn:accp:artifact-content:" + q.http.PathValue("id")}}, nil
}

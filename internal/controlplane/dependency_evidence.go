package controlplane

import (
	"encoding/json"

	"github.com/JavaWeh/ACCP/internal/auth"
)

func resolveDependencyEvidence(q *request, task string) error {
	_, e := q.tx.Exec(q.http.Context(), `UPDATE task_dependencies d SET resolved_artifact_id=(SELECT a.id FROM artifacts a JOIN task_runs r ON r.id=a.run_id WHERE r.task_id=d.predecessor_task_id AND a.project_id=d.project_id AND a.verification_status='VERIFIED' AND a.acceptance_status='ACCEPTED' AND a.document->>'kind'=d.condition->>'artifact_kind' ORDER BY a.id LIMIT 1) WHERE d.successor_task_id=$1 AND d.project_id=$2 AND d.condition->>'kind'='ARTIFACT_ACCEPTED' AND d.resolved_artifact_id IS NULL`, task, q.project)
	return e
}
func dependencySnapshot(q *request, task string, entries []Object) ([]Object, []Object, error) {
	rows, e := q.tx.Query(q.http.Context(), `SELECT a.document FROM task_dependencies d JOIN artifacts a ON a.id=d.resolved_artifact_id WHERE d.successor_task_id=$1 AND d.project_id=$2 ORDER BY a.id`, task, q.project)
	if e != nil {
		return nil, nil, e
	}
	artifacts := []Object{}
	for rows.Next() {
		var data []byte
		if e = rows.Scan(&data); e != nil {
			rows.Close()
			return nil, nil, e
		}
		var doc Object
		if e = json.Unmarshal(data, &doc); e != nil {
			rows.Close()
			return nil, nil, e
		}
		artifacts = append(artifacts, doc)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, nil, e
	}
	refs := []Object{}
	for _, a := range artifacts {
		refs = append(refs, Object{"artifact_id": a["id"], "content_digest": a["content_digest"], "version": a["version"], "task_id": a["provenance"].(map[string]any)["task_id"]})
		if a["kind"] != "API_DOCUMENT" {
			continue
		}
		v, e := readDocument(q, "context_versions", textValue(a, "context_version_id"))
		if e != nil {
			return nil, nil, e
		}
		if v["status"] != "PUBLISHED" || v["content_digest"] != a["content_digest"] {
			return nil, nil, fail(409, "DEPENDENCY_CONTEXT_INVALID", "Accepted API evidence must retain its published Context.")
		}
		present := false
		for _, entry := range entries {
			if entry["context_id"] == v["context_id"] {
				if entry["context_version_id"] != v["id"] {
					return nil, nil, fail(409, "CONTEXT_CONFLICT", "Task input and accepted API dependency select different versions; create an explicit corrected task.")
				}
				present = true
			}
		}
		if !present {
			entries = append(entries, Object{"context_id": v["context_id"], "context_version_id": v["id"], "content_digest": v["content_digest"]})
		}
	}
	return entries, refs, nil
}
func snapshotDigest(entries, refs []Object) string {
	var canonical []byte
	if len(refs) == 0 {
		canonical, _ = json.Marshal(entries)
	} else {
		canonical, _ = json.Marshal(Object{"entries": entries, "artifact_refs": refs})
	}
	return auth.Digest(string(canonical))
}

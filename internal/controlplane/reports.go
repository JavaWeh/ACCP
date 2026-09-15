package controlplane

import (
	"encoding/json"
	"time"
)

func listRunReports(q *request) (reply, error) {
	if _, err := getRun(q); err != nil {
		return reply{}, err
	}
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT id,document,created_at FROM run_reports WHERE run_id=$1 AND project_id=$2 AND organization_id=$3 AND id>$4 ORDER BY id LIMIT $5`, q.http.PathValue("id"), q.project, q.org, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id string
		var data []byte
		var stamp time.Time
		if err = rows.Scan(&id, &data, &stamp); err != nil {
			return reply{}, err
		}
		var report Object
		if err = json.Unmarshal(data, &report); err != nil {
			return reply{}, err
		}
		items = append(items, Object{"id": id, "run_id": q.http.PathValue("id"), "project_id": q.project, "organization_id": q.org, "report": report, "created_at": stamp.UTC().Format(time.RFC3339Nano)})
	}
	return page(q.http, items, limit), rows.Err()
}

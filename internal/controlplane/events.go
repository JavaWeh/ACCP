package controlplane

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func emitEvent(q *request, kind, aggregate string, version int64, detail Object) error {
	detail["organization_id"] = q.org
	detail["project_id"] = q.project
	detail["aggregate_id"] = aggregate
	detail["aggregate_version"] = version
	detail["correlation_id"] = q.trace
	detail["causation_id"] = q.trace
	event := Object{"specversion": "1.0", "id": newID("event"), "source": "urn:accp:control-plane", "type": "io.accp." + kind + ".v1", "subject": aggregate, "time": now(), "datacontenttype": "application/json", "data": detail}
	data, _ := json.Marshal(event)
	// Validate the JSON representation (the validator does not accept Go int64).
	var canonical Object
	_ = json.Unmarshal(data, &canonical)
	if err := q.server.schemas["M2Event"].Validate(canonical); err != nil {
		return fmt.Errorf("invalid generated event %s: %w", kind, err)
	}
	_, err := q.tx.Exec(q.http.Context(), `INSERT INTO outbox_events(id,project_id,organization_id,event) VALUES($1,$2,$3,$4)`, event["id"], q.project, q.org, data)
	return err
}
func recordAudit(q *request, action, resource string, version int64) error {
	kind := "HUMAN"
	var sessionID, runID, owner, snapshot any
	if q.session != nil {
		kind = "AGENT"
		sessionID = q.session.ID
	}
	// Derive execution responsibility from persisted Run data, never request identity fields.
	id := q.http.PathValue("id")
	if strings.Contains(action, "/claim") {
		id = resource
	}
	var run []byte
	err := q.tx.QueryRow(q.http.Context(), `SELECT document FROM task_runs WHERE id=$1 AND project_id=$2`, id, q.project).Scan(&run)
	if err == nil {
		var doc Object
		_ = json.Unmarshal(run, &doc)
		runID = doc["id"]
		owner = doc["owner_user_id"]
		snapshot = doc["context_snapshot_id"]
	} else if err != pgx.ErrNoRows {
		return err
	}
	details := Object{}
	if strings.Contains(action, "/reviews") || strings.Contains(action, "/verifications") || strings.Contains(action, "/decisions") {
		var evidence []byte
		switch {
		case strings.Contains(action, "/tasks/"):
			err = q.tx.QueryRow(q.http.Context(), `SELECT r.document FROM task_runs r WHERE r.task_id=$1 AND r.project_id=$2 ORDER BY attempt DESC LIMIT 1`, id, q.project).Scan(&evidence)
		case strings.Contains(action, "/artifacts/"):
			err = q.tx.QueryRow(q.http.Context(), `SELECT r.document FROM artifacts a JOIN task_runs r ON r.id=a.run_id WHERE a.id=$1 AND a.project_id=$2`, id, q.project).Scan(&evidence)
			details["artifact_ids"] = []string{id}
		case strings.Contains(action, "/approvals/"):
			err = q.tx.QueryRow(q.http.Context(), `SELECT r.document FROM approvals a JOIN tool_invocations i ON i.id=a.invocation_id JOIN task_runs r ON r.id=i.run_id WHERE a.id=$1 AND a.project_id=$2`, id, q.project).Scan(&evidence)
			details["approval_id"] = id
		}
		if err == nil && len(evidence) > 0 {
			var doc Object
			_ = json.Unmarshal(evidence, &doc)
			runID = doc["id"]
			owner = doc["owner_user_id"]
			snapshot = doc["context_snapshot_id"]
			details["delegated_by_user_id"] = doc["delegated_by_user_id"]
			details["execution_session_id"] = doc["session_id"]
			details["reviewed_by_user_id"] = q.user
		}
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
	}
	metadata, _ := json.Marshal(details)
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO audit_records(id,project_id,organization_id,actor_user_id,action,resource_id,resource_version,trace_id,actor_kind,actor_session_id,task_run_id,owner_user_id,context_snapshot_id,reason,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, newID("audit"), q.project, q.org, q.user, action, resource, version, q.trace, kind, sessionID, runID, owner, snapshot, textValue(q.body, "reason"), metadata)
	return err
}

type eventCursor struct {
	Project  string `json:"project"`
	Sequence int64  `json:"sequence"`
	Issued   int64  `json:"issued"`
}

func pollEvents(q *request) (reply, error) {
	if q.server.signer == nil {
		return reply{}, fail(503, "EVENTS_UNAVAILABLE", "Configure the server signing key.")
	}
	limit := 50
	if raw := q.http.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			return reply{}, fail(400, "INVALID_PAGE", "limit must be between 1 and 100.")
		}
		limit = n
	}
	c := eventCursor{Project: q.project, Issued: time.Now().Unix()}
	raw := q.http.URL.Query().Get("cursor")
	if raw == "" {
		raw = q.http.Header.Get("Last-Event-ID")
	}
	if raw != "" {
		data, err := q.server.signer.Open("event-cursor", raw)
		if err != nil || json.Unmarshal([]byte(data), &c) != nil || c.Project != q.project || c.Sequence < 0 || c.Issued > time.Now().Unix()+60 {
			return reply{}, fail(400, "INVALID_CURSOR", "Use a server-issued cursor for this project.")
		}
		if c.Issued < time.Now().Add(-7*24*time.Hour).Unix() {
			return reply{}, fail(410, "CURSOR_EXPIRED", "Cursor retention is seven days; reconcile task state and subscribe again.")
		}
		var expiredSequence int64
		if err = q.tx.QueryRow(q.http.Context(), `SELECT coalesce(max(sequence),0) FROM event_feed WHERE project_id=$1 AND recorded_at<=now()-interval '7 days'`, q.project).Scan(&expiredSequence); err != nil {
			return reply{}, err
		}
		if c.Sequence < expiredSequence {
			return reply{}, fail(410, "CURSOR_EXPIRED", "The cursor fell behind retained events; reconcile current task state.")
		}
	}
	rows, err := q.tx.Query(q.http.Context(), `SELECT sequence,event FROM event_feed WHERE project_id=$1 AND organization_id=$2 AND sequence>$3 AND recorded_at>now()-interval '7 days' ORDER BY sequence LIMIT $4`, q.project, q.org, c.Sequence, limit)
	if err != nil {
		return reply{}, err
	}
	items := []Object{}
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&c.Sequence, &data); err != nil {
			rows.Close()
			return reply{}, err
		}
		var doc Object
		if err = json.Unmarshal(data, &doc); err != nil {
			rows.Close()
			return reply{}, err
		}
		items = append(items, doc)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return reply{}, err
	}
	c.Issued = time.Now().Unix()
	encoded, _ := json.Marshal(c)
	return reply{status: 200, body: Object{"items": items, "next_cursor": q.server.signer.Seal("event-cursor", string(encoded))}}, nil
}
func (s *Server) streamEvents(w http.ResponseWriter, r *http.Request, op operation) {
	ctx, cancel := context.WithTimeout(r.Context(), 24*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	// Short streams fit the HTTP write deadline. Every page reauthenticates membership and Session.
	trace := newID("trace")
	w.Header().Set("X-Request-ID", trace)
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeProblem(w, trace, fail(500, "STREAM_UNAVAILABLE", "Streaming is unavailable."))
		return
	}
	result, err := s.execute(w, r, op, trace)
	if err != nil {
		writeProblem(w, trace, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		body := result.body.(map[string]any)
		cursor := textValue(body, "next_cursor")
		// Each page is one SSE message: its cursor is acknowledged only after the whole page is received.
		payload, _ := json.Marshal(body)
		if _, err = fmt.Fprintf(w, "id: %s\nevent: accp.events\ndata: %s\n\n", cursor, payload); err != nil {
			return
		}
		flusher.Flush()
		select {
		case <-r.Context().Done():
			return
		case <-deadline.C:
			return
		case <-ticker.C:
		}
		clone := r.Clone(r.Context())
		query := clone.URL.Query()
		query.Set("cursor", cursor)
		clone.URL.RawQuery = query.Encode()
		result, err = s.execute(w, clone, op, trace)
		if err != nil {
			_, _ = fmt.Fprint(w, "event: accp.closed\ndata: {\"reason\":\"reauthenticate_or_reconcile\"}\n\n")
			flusher.Flush()
			return
		}
	}
}
func replayEvent(q *request) (reply, error) {
	id := q.http.PathValue("event")
	tag, err := q.tx.Exec(q.http.Context(), `UPDATE outbox_events SET delivered_at=NULL,replay_version=replay_version+1,attempts=0,next_attempt_at=now(),last_error_code=NULL WHERE id=$1 AND project_id=$2`, id, q.project)
	if err != nil {
		return reply{}, err
	}
	if tag.RowsAffected() != 1 {
		return reply{}, fail(404, "NOT_FOUND", "Event not found.")
	}
	return reply{status: 202, resource: id, version: 1, body: Object{"event_id": id, "status": "REPLAY_QUEUED"}}, nil
}

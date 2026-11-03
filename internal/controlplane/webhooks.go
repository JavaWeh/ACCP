package controlplane

import (
	"time"

	"github.com/jackc/pgx/v5"
)

// F5 (US-22) outbound webhook management. Project ADMINs register signed HTTPS
// endpoints that receive a redacted projection of the project event feed. The
// signing secret is generated server-side, stored as AES-256-GCM ciphertext and
// echoed in cleartext exactly once (on create and on rotate); it is never
// returned by list or get. Fan-out and delivery live in webhook_delivery.go.

// webhookEventKind maps the user-facing subscription names (aligned with the F3
// notification taxonomy) to the internal event kind carried on the feed. A
// BLOCKED task is expressed internally by TASK_FAILED, so the subscription name
// TASK_BLOCKED binds to the TASK_FAILED event kind.
var webhookEventKind = map[string]string{
	"REVIEW_REQUIRED":  "REVIEW_REQUIRED",
	"APPROVAL_DECIDED": "APPROVAL_DECIDED",
	"TASK_BLOCKED":     "TASK_FAILED",
}

func (s *Server) webhookRoutes(routes map[string]operation) {
	for path, op := range map[string]operation{
		"GET /api/v1/projects/{id}/webhooks":                      {table: "projects", role: "ADMIN", run: listWebhooks},
		"POST /api/v1/projects/{id}/webhooks":                     {table: "projects", role: "ADMIN", schema: "ManagementCreateWebhook", run: createWebhook},
		"POST /api/v1/projects/{id}/webhooks/{wid}/changes":       {table: "projects", role: "ADMIN", conditional: true, schema: "ManagementWebhookChange", run: changeWebhook},
		"POST /api/v1/projects/{id}/webhooks/{wid}/rotate-secret": {table: "projects", role: "ADMIN", run: rotateWebhookSecret},
		"POST /api/v1/projects/{id}/webhooks/{wid}/delete":        {table: "projects", role: "ADMIN", run: deleteWebhook},
	} {
		routes[path] = op
	}
}

func webhookDoc(id, org, project, url string, events []string, enabled bool, created time.Time, version int64) Object {
	return Object{
		"id": id, "organization_id": org, "project_id": project, "url": url,
		"event_types": events, "enabled": enabled,
		"created_at": created.UTC().Format(time.RFC3339Nano), "version": version,
	}
}

// webhookEventTypes projects the validated request array onto []string, rejecting
// any name not in the subscription whitelist (defence in depth beyond the schema
// enum, aligned with governance "deny unless explicitly allowed").
func webhookEventTypes(value any) ([]string, bool) {
	arr, ok := value.([]any)
	if !ok || len(arr) == 0 {
		return nil, false
	}
	types := make([]string, 0, len(arr))
	for _, item := range arr {
		name, ok := item.(string)
		if !ok {
			return nil, false
		}
		if _, allowed := webhookEventKind[name]; !allowed {
			return nil, false
		}
		types = append(types, name)
	}
	return types, true
}

func listWebhooks(q *request) (reply, error) {
	limit, cursor, err := pageParams(q.http)
	if err != nil {
		return reply{}, err
	}
	rows, err := q.tx.Query(q.http.Context(), `
		SELECT e.id,e.url,e.event_types,e.enabled,e.created_at,e.version,d.last_status,d.last_error_code,d.last_at
		FROM webhook_endpoints e
		LEFT JOIN LATERAL (
			SELECT last_status,last_error_code,coalesce(delivered_at,abandoned_at,next_attempt_at) AS last_at
			FROM webhook_deliveries WHERE endpoint_id=e.id ORDER BY created_at DESC LIMIT 1
		) d ON true
		WHERE e.organization_id=$1 AND e.project_id=$2 AND e.id>$3 ORDER BY e.id LIMIT $4`,
		q.org, q.project, cursor, limit+1)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, url string
		var events []string
		var enabled bool
		var created time.Time
		var version int64
		var lastStatus *int
		var lastError *string
		var lastAt *time.Time
		if err = rows.Scan(&id, &url, &events, &enabled, &created, &version, &lastStatus, &lastError, &lastAt); err != nil {
			return reply{}, err
		}
		doc := webhookDoc(id, q.org, q.project, url, events, enabled, created, version)
		if lastStatus != nil {
			doc["last_status"] = *lastStatus
		}
		if lastError != nil {
			doc["last_error_code"] = *lastError
		}
		if lastAt != nil {
			doc["last_delivered_at"] = lastAt.UTC().Format(time.RFC3339Nano)
		}
		items = append(items, doc)
	}
	return page(q.http, items, limit), rows.Err()
}

func createWebhook(q *request) (reply, error) {
	if q.server.signer == nil {
		return reply{}, fail(503, "WEBHOOK_SIGNING_UNAVAILABLE", "The server is not configured to store webhook signing secrets.")
	}
	events, ok := webhookEventTypes(q.body["event_types"])
	if !ok {
		return reply{}, fail(400, "WEBHOOK_URL_REJECTED", "Subscribe to at least one supported event type.")
	}
	url := textValue(q.body, "url")
	if err := validateWebhookURL(q.http.Context(), url, q.server.options.WebhookAllowlist, webhookResolve); err != nil {
		return reply{}, err
	}
	secret, sealed, err := newWebhookSecret(q.server)
	if err != nil {
		return reply{}, err
	}
	id := newID("webhook")
	// Only future events: start the high-water mark at the current feed cursor.
	var cursor int64
	if err = q.tx.QueryRow(q.http.Context(), `SELECT coalesce(max(sequence),0) FROM event_feed WHERE project_id=$1`, q.project).Scan(&cursor); err != nil {
		return reply{}, err
	}
	var created time.Time
	err = q.tx.QueryRow(q.http.Context(), `INSERT INTO webhook_endpoints(id,organization_id,project_id,url,event_types,signing_secret,created_by_user_id,delivered_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`,
		id, q.org, q.project, url, events, sealed, q.user, cursor).Scan(&created)
	if err != nil {
		return reply{}, err
	}
	doc := webhookDoc(id, q.org, q.project, url, events, true, created, 1)
	doc["signing_secret"] = secret
	return reply{status: 201, body: doc, resource: id, version: 1}, nil
}

func changeWebhook(q *request) (reply, error) {
	wid := q.http.PathValue("wid")
	var url string
	var events []string
	var enabled bool
	var version int64
	err := q.tx.QueryRow(q.http.Context(), `SELECT url,event_types,enabled,version FROM webhook_endpoints WHERE id=$1 AND project_id=$2 AND organization_id=$3 FOR UPDATE`, wid, q.project, q.org).Scan(&url, &events, &enabled, &version)
	if err == pgx.ErrNoRows {
		return reply{}, fail(404, "NOT_FOUND", "Webhook not found.")
	}
	if err != nil {
		return reply{}, err
	}
	if err = match(q, version); err != nil {
		return reply{}, err
	}
	if raw, present := q.body["url"]; present {
		next, ok := raw.(string)
		if !ok {
			return reply{}, fail(400, "WEBHOOK_URL_REJECTED", "A webhook URL must be a string.")
		}
		// A changed URL is re-validated against the allowlist and SSRF rules.
		if err = validateWebhookURL(q.http.Context(), next, q.server.options.WebhookAllowlist, webhookResolve); err != nil {
			return reply{}, err
		}
		url = next
	}
	if raw, present := q.body["event_types"]; present {
		next, ok := webhookEventTypes(raw)
		if !ok {
			return reply{}, fail(400, "WEBHOOK_URL_REJECTED", "Subscribe to at least one supported event type.")
		}
		events = next
	}
	if raw, present := q.body["enabled"]; present {
		next, ok := raw.(bool)
		if !ok {
			return reply{}, fail(400, "WEBHOOK_URL_REJECTED", "The enabled flag must be a boolean.")
		}
		enabled = next
	}
	version++
	var created time.Time
	err = q.tx.QueryRow(q.http.Context(), `UPDATE webhook_endpoints SET url=$2,event_types=$3,enabled=$4,version=$5 WHERE id=$1 RETURNING created_at`, wid, url, events, enabled, version).Scan(&created)
	if err != nil {
		return reply{}, err
	}
	return entity(200, webhookDoc(wid, q.org, q.project, url, events, enabled, created, version)), nil
}

func rotateWebhookSecret(q *request) (reply, error) {
	if q.server.signer == nil {
		return reply{}, fail(503, "WEBHOOK_SIGNING_UNAVAILABLE", "The server is not configured to store webhook signing secrets.")
	}
	wid := q.http.PathValue("wid")
	secret, sealed, err := newWebhookSecret(q.server)
	if err != nil {
		return reply{}, err
	}
	var url string
	var events []string
	var enabled bool
	var created time.Time
	var version int64
	err = q.tx.QueryRow(q.http.Context(), `UPDATE webhook_endpoints SET signing_secret=$2,version=version+1 WHERE id=$1 AND project_id=$3 AND organization_id=$4 RETURNING url,event_types,enabled,created_at,version`, wid, sealed, q.project, q.org).Scan(&url, &events, &enabled, &created, &version)
	if err == pgx.ErrNoRows {
		return reply{}, fail(404, "NOT_FOUND", "Webhook not found.")
	}
	if err != nil {
		return reply{}, err
	}
	doc := webhookDoc(wid, q.org, q.project, url, events, enabled, created, version)
	doc["signing_secret"] = secret
	return reply{status: 200, body: doc, resource: wid, version: version}, nil
}

func deleteWebhook(q *request) (reply, error) {
	wid := q.http.PathValue("wid")
	// Deleting the endpoint cascades to its undelivered deliveries; history is
	// not retained long-term for an unregistered endpoint.
	tag, err := q.tx.Exec(q.http.Context(), `DELETE FROM webhook_endpoints WHERE id=$1 AND project_id=$2 AND organization_id=$3`, wid, q.project, q.org)
	if err != nil {
		return reply{}, err
	}
	if tag.RowsAffected() != 1 {
		return reply{}, fail(404, "NOT_FOUND", "Webhook not found.")
	}
	return reply{status: 200, resource: wid, version: 1, body: Object{"id": wid, "status": "DELETED"}}, nil
}

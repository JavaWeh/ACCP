// Package controlplane implements the HTTP application and its transaction boundary.
package controlplane

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
	"github.com/JavaWeh/ACCP/internal/database"
	"github.com/JavaWeh/ACCP/internal/gateway"
	"github.com/JavaWeh/ACCP/internal/gitprovider"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Server struct {
	pool    *pgxpool.Pool
	auth    auth.Authenticator
	schemas Validator
	mux     *http.ServeMux
	signer  *auth.SessionSigner
	options Options
}
type Options struct {
	SessionKey   []byte
	SessionKeys  map[string][]byte
	ActiveKeyID  string
	PublicURL    string
	GitProvider  gitprovider.Provider
	Tools        *gateway.Registry
	WebDirectory string
	AuthMode     string
	OIDCIssuer   string
	OIDCClientID string
}
type request struct {
	tx                        pgx.Tx
	http                      *http.Request
	user, org, project, trace string
	roles                     []string
	body                      Object
	server                    *Server
	session                   *sessionPrincipal
}
type reply struct {
	status   int
	body     any
	etag     string
	resource string
	version  int64
}
type problem struct {
	status       int
	code, detail string
}

func (p problem) Error() string                  { return p.code }
func fail(status int, code, detail string) error { return problem{status, code, detail} }

type operation struct {
	maintenanceWrite    bool
	organization        bool
	archivedWrite       bool
	table, schema, role string
	conditional         bool
	run                 func(*request) (reply, error)
	scope               string
	agentOnly           bool
	bodyProject         bool
	queryProject        bool
	fenced              bool
	grant               bool
}

func New(pool *pgxpool.Pool, authenticator auth.Authenticator, options ...Options) (*Server, error) {
	schemas, err := NewValidator()
	if err != nil {
		return nil, err
	}
	s := &Server{pool: pool, auth: authenticator, schemas: schemas, mux: http.NewServeMux()}
	if len(options) > 0 {
		s.options = options[0]
		s.signer, err = auth.NewSessionSigner(s.options.SessionKey)
		if len(s.options.SessionKeys) > 0 {
			s.signer, err = auth.NewKeyring(s.options.ActiveKeyID, s.options.SessionKeys, s.options.SessionKey)
		}
		if err != nil {
			return nil, err
		}
	}
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		respond(w, reply{status: 200, body: Object{"status": "ok"}})
	})
	s.mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := database.Ready(ctx, pool); err != nil {
			respond(w, reply{status: 503, body: Object{"status": "unavailable"}})
			return
		}
		respond(w, reply{status: 200, body: Object{"status": "ready"}})
	})
	routes := map[string]operation{
		"GET /api/v1/me":                                        {run: me},
		"GET /api/v1/projects":                                  {run: projects},
		"GET /api/v1/projects/{id}/members":                     {table: "projects", run: members},
		"POST /api/v1/projects/{id}/members/{user}/changes":     {table: "projects", schema: "MembershipChange", role: "ADMIN", conditional: true, run: changeMember},
		"GET /api/v1/projects/{id}/repositories":                {table: "projects", run: listResources("repositories", "")},
		"GET /api/v1/projects/{id}/tasks":                       {table: "projects", run: listResources("tasks", "")},
		"POST /api/v1/projects/{id}/tasks":                      {table: "projects", schema: "CreateTask", role: "MEMBER", run: createTask},
		"GET /api/v1/tasks/{id}":                                {table: "tasks", run: getResource("tasks")},
		"POST /api/v1/tasks/{id}/commands":                      {table: "tasks", schema: "TaskCommand", conditional: true, run: commandTask},
		"GET /api/v1/projects/{id}/contexts":                    {table: "projects", run: listResources("contexts", "")},
		"POST /api/v1/projects/{id}/contexts":                   {table: "projects", schema: "CreateContext", role: "MEMBER", run: createContext},
		"GET /api/v1/contexts/{id}":                             {table: "contexts", run: getResource("contexts")},
		"GET /api/v1/contexts/{id}/versions":                    {table: "contexts", run: listResources("context_versions", "context_id")},
		"POST /api/v1/contexts/{id}/versions":                   {table: "contexts", schema: "CreateContextVersion", role: "MEMBER", conditional: true, run: createVersion},
		"GET /api/v1/contexts/{id}/versions/{version}":          {table: "contexts", run: getVersion},
		"POST /api/v1/contexts/{id}/versions/{version}/publish": {table: "contexts", role: "REVIEWER", conditional: true, run: publishVersion},
		"POST /api/v1/projects/{id}/contents":                   {table: "projects", schema: "UploadContent", role: "MEMBER", run: uploadContent},
		"GET /api/v1/contents/{id}":                             {table: "context_contents", run: getContent},
		"GET /api/v1/projects/{id}/audit-records":               {table: "projects", role: "REVIEWER", run: listAudit},
	}
	s.extendRoutes(routes)
	s.deliveryRoutes(routes)
	s.managementRoutes(routes)
	s.operationsRoutes(routes)
	s.lifecycleRoutes(routes)
	for pattern, op := range routes {
		s.mux.HandleFunc(pattern, s.handle(op))
	}
	s.mountConsole()
	s.mountGateway()
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	s.mux.ServeHTTP(w, r)
}

func (s *Server) handle(op operation) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/events" && strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
			s.streamEvents(w, r, op)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		trace := newID("trace")
		w.Header().Set("X-Request-ID", trace)
		result, err := s.execute(w, r, op, trace)
		if err != nil {
			s.recordDenial(r, op, trace, err)
			writeProblem(w, trace, err)
			return
		}
		respond(w, result)
	}
}

func (s *Server) execute(w http.ResponseWriter, r *http.Request, op operation, trace string) (reply, error) {
	empty := reply{}
	fields := strings.Fields(r.Header.Get("Authorization"))
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || len(fields[1]) > 16384 {
		return empty, fail(401, "UNAUTHENTICATED", "A valid bearer token is required.")
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return empty, err
	}
	defer tx.Rollback(r.Context())
	q := &request{tx: tx, http: r, trace: trace, server: s}
	if err = s.authenticate(q, fields[1], op); err != nil {
		return empty, err
	}
	write := r.Method == http.MethodPost
	if write {
		allowed, e := database.RuntimeAllowed(r.Context(), tx)
		if e != nil {
			return empty, e
		}
		if !allowed && !op.maintenanceWrite {
			return empty, fail(503, "MAINTENANCE", "The installation is under maintenance; retain this request and its idempotency key.")
		}
		q.body, err = decode(w, r, op.schema != "")
		if err != nil {
			return empty, err
		}
		if op.schema != "" && s.schemas[op.schema].Validate(q.body) != nil {
			return empty, fail(400, "INVALID_BODY", "The request does not match the published JSON Schema.")
		}
	}
	if op.organization {
		return s.executeOrganization(q, op)
	}
	if op.table != "" || op.bodyProject || op.queryProject || q.session != nil {
		switch {
		case op.bodyProject:
			q.project = textValue(q.body, "project_id")
		case op.queryProject:
			q.project = r.URL.Query().Get("project_id")
		case op.table == "projects":
			q.project = r.PathValue("id")
		case op.table != "":
			err = tx.QueryRow(r.Context(), `SELECT project_id FROM `+op.table+` WHERE id=$1 AND organization_id=$2`, r.PathValue("id"), q.org).Scan(&q.project)
			if err == pgx.ErrNoRows {
				return empty, fail(404, "NOT_FOUND", "Resource not found.")
			}
			if err != nil {
				return empty, err
			}
		}
		lock := " FOR SHARE"
		if write {
			lock = " FOR UPDATE"
		}
		var project, projectStatus string
		err = tx.QueryRow(r.Context(), `SELECT id,status FROM projects WHERE id=$1 AND organization_id=$2`+lock, q.project, q.org).Scan(&project, &projectStatus)
		if err == pgx.ErrNoRows {
			return empty, fail(404, "NOT_FOUND", "Project not found.")
		}
		if err != nil {
			return empty, err
		}
		err = tx.QueryRow(r.Context(), `SELECT roles FROM memberships WHERE project_id=$1 AND user_id=$2 AND organization_id=$3 AND active`, q.project, q.user, q.org).Scan(&q.roles)
		if err == pgx.ErrNoRows {
			return empty, fail(404, "NOT_FOUND", "Project not found.")
		}
		if err != nil {
			return empty, err
		}
		if op.role != "" && !hasRole(q.roles, op.role) {
			return empty, fail(403, "FORBIDDEN", "Your current project role does not permit this operation.")
		}
		if err = s.authorizeSession(q, op); err != nil {
			return empty, err
		}
		if write && projectStatus == "ARCHIVED" && !op.archivedWrite {
			return empty, fail(409, "PROJECT_ARCHIVED", "Restore the project before writing; historical data is read-only.")
		}
	}
	var key, digest, route string
	if write {
		key = r.Header.Get("Idempotency-Key")
		if len(key) < 8 || len(key) > 128 || strings.TrimSpace(key) != key {
			return empty, fail(400, "IDEMPOTENCY_KEY_REQUIRED", "Use an Idempotency-Key of 8 to 128 characters.")
		}
		if op.conditional && r.Header.Get("If-Match") == "" {
			return empty, fail(428, "PRECONDITION_REQUIRED", "A quoted resource version is required in If-Match.")
		}
		if op.fenced && r.Header.Get("X-Run-Fencing-Token") == "" {
			return empty, fail(428, "FENCING_TOKEN_REQUIRED", "A current Run fencing token is required.")
		}
		canonical, err := json.Marshal(q.body)
		if err != nil {
			return empty, err
		}
		route = r.Method + " " + r.URL.Path
		hashInput := route + "\n" + r.Header.Get("If-Match") + "\n" + string(canonical)
		if op.fenced {
			hashInput = route + "\n" + r.Header.Get("If-Match") + "\n" + r.Header.Get("X-Run-Fencing-Token") + "\n" + string(canonical)
		}
		digest = auth.Digest(hashInput)
		var stored string
		var data []byte
		var cached reply
		err = tx.QueryRow(r.Context(), `SELECT request_digest,status,body,etag FROM idempotency_records WHERE project_id=$1 AND actor_key=$2 AND route=$3 AND key=$4 AND expires_at>now()`, q.project, q.actorKey(), route, key).Scan(&stored, &cached.status, &data, &cached.etag)
		if err == nil {
			if stored != digest {
				return empty, fail(409, "IDEMPOTENCY_CONFLICT", "This key already identifies a different request.")
			}
			if err = json.Unmarshal(data, &cached.body); err != nil {
				return empty, err
			}
			if err = s.authorizeReplay(q, op, cached); err != nil {
				return empty, err
			}
			return s.hydrateGrant(q, op, cached)
		}
		if err != pgx.ErrNoRows {
			return empty, err
		}
	}
	result, err := op.run(q)
	if err != nil {
		return empty, err
	}
	if write {
		if err = recordAudit(q, r.Pattern, result.resource, result.version); err != nil {
			return empty, err
		}
		data, err := json.Marshal(result.body)
		if err != nil {
			return empty, err
		}
		_, err = tx.Exec(r.Context(), `INSERT INTO idempotency_records(project_id,organization_id,user_id,actor_key,route,key,request_digest,status,body,etag) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(project_id,actor_key,route,key) DO UPDATE SET request_digest=EXCLUDED.request_digest,status=EXCLUDED.status,body=EXCLUDED.body,etag=EXCLUDED.etag,expires_at=now()+interval '24 hours'`, q.project, q.org, q.user, q.actorKey(), route, key, digest, result.status, data, result.etag)
		if err != nil {
			return empty, err
		}
	}
	result, err = s.hydrateGrant(q, op, result)
	if err != nil {
		return empty, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return empty, err
	}
	return result, nil
}

func decode(w http.ResponseWriter, r *http.Request, required bool) (Object, error) {
	if !required && r.ContentLength == 0 {
		return Object{}, nil
	}
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" {
		return nil, fail(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.")
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	var value Object
	if err = d.Decode(&value); err != nil || value == nil {
		return nil, fail(400, "INVALID_JSON", "A bounded JSON object is required.")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return nil, fail(400, "INVALID_JSON", "Only one JSON object is allowed.")
	}
	if !required && len(value) != 0 {
		return nil, fail(400, "INVALID_BODY", "This operation accepts only an empty body.")
	}
	return value, nil
}

func respond(w http.ResponseWriter, result reply) {
	w.Header().Set("Content-Type", "application/json")
	if result.etag != "" {
		w.Header().Set("ETag", result.etag)
	}
	w.WriteHeader(result.status)
	_ = json.NewEncoder(w).Encode(result.body)
}

func writeProblem(w http.ResponseWriter, trace string, err error) {
	p := problem{500, "INTERNAL_ERROR", "The operation could not be completed. Use trace_id when reporting this error."}
	if !errors.As(err, &p) {
		slog.Error("request failed", "trace_id", trace, "error_type", fmt.Sprintf("%T", err))
	}
	w.Header().Set("Content-Type", "application/problem+json")
	if p.status == 401 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="accp"`)
	}
	w.WriteHeader(p.status)
	_ = json.NewEncoder(w).Encode(Object{"type": "urn:accp:problem:" + p.code, "title": http.StatusText(p.status), "status": p.status, "code": p.code, "detail": p.detail, "trace_id": trace})
}

func newID(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("secure randomness unavailable")
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}
func hasRole(roles []string, role string) bool {
	for _, r := range roles {
		if r == "ADMIN" || r == role {
			return true
		}
	}
	return false
}
func textValue(obj Object, key string) string { value, _ := obj[key].(string); return value }
func number(obj Object, key string) int64     { n, _ := obj[key].(float64); return int64(n) }
func now() string                             { return time.Now().UTC().Format(time.RFC3339Nano) }
func entity(status int, doc Object) reply {
	v := number(doc, "version")
	if n, ok := doc["version"].(int64); ok {
		v = n
	}
	return reply{status: status, body: doc, etag: fmt.Sprintf(`"%d"`, v), resource: textValue(doc, "id"), version: v}
}
func match(q *request, version int64) error {
	if q.http.Header.Get("If-Match") != fmt.Sprintf(`"%d"`, version) {
		return fail(412, "VERSION_CONFLICT", "The resource version changed; read it again.")
	}
	return nil
}

func pageParams(r *http.Request) (int, string, error) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			return 0, "", fail(400, "INVALID_PAGE", "limit must be between 1 and 100.")
		}
		limit = n
	}
	cursor := ""
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		data, err := base64.RawURLEncoding.DecodeString(raw)
		var c struct{ Path, ID string }
		if err != nil || json.Unmarshal(data, &c) != nil || c.Path != r.URL.Path || len(c.ID) > 128 || c.ID == "" {
			return 0, "", fail(400, "INVALID_CURSOR", "The cursor must belong to this collection.")
		}
		cursor = c.ID
	}
	return limit, cursor, nil
}
func page(r *http.Request, items []Object, limit int) reply {
	body := Object{"items": items, "next_cursor": nil}
	if len(items) > limit {
		body["items"] = items[:limit]
		data, _ := json.Marshal(struct{ Path, ID string }{r.URL.Path, textValue(items[limit-1], "id")})
		body["next_cursor"] = base64.RawURLEncoding.EncodeToString(data)
	}
	return reply{status: 200, body: body}
}

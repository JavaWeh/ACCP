// Package observability exposes bounded metrics on a separate internal listener.
package observability

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

var boundaries = []float64{.01, .05, .1, .25, .5, 1, 2.5, 5, 15}

type sample struct {
	Count   uint64
	Sum     float64
	Buckets [9]uint64
}
type Metrics struct {
	mu       sync.Mutex
	requests map[string]*sample
	pool     *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Metrics { return &Metrics{requests: map[string]*sample{}, pool: pool} }

type response struct {
	http.ResponseWriter
	status int
}

func (w *response) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *response) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}
func (w *response) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *response) Flush() {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}
func (m *Metrics) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		out := &response{ResponseWriter: w}
		next.ServeHTTP(out, r)
		status := out.status
		if status == 0 {
			status = 200
		}
		route := r.Pattern
		if route == "" {
			route = "unmatched"
		}
		key := fmt.Sprintf("route=%q,status_class=%q", route, fmt.Sprintf("%dxx", status/100))
		elapsed := time.Since(started).Seconds()
		m.mu.Lock()
		defer m.mu.Unlock()
		if len(m.requests) >= 512 && m.requests[key] == nil {
			key = `route="overflow",status_class="other"`
		}
		s := m.requests[key]
		if s == nil {
			s = &sample{}
			m.requests[key] = s
		}
		s.Count++
		s.Sum += elapsed
		for i, b := range boundaries {
			if elapsed <= b {
				s.Buckets[i]++
			}
		}
	})
}
func (m *Metrics) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" || r.URL.Path != "/metrics" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	var b strings.Builder
	b.WriteString("# TYPE accp_http_request_duration_seconds histogram\n")
	m.mu.Lock()
	keys := make([]string, 0, len(m.requests))
	for key := range m.requests {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		s := m.requests[key]
		for i, limit := range boundaries {
			fmt.Fprintf(&b, "accp_http_request_duration_seconds_bucket{%s,le=%q} %d\n", key, fmt.Sprint(limit), s.Buckets[i])
		}
		fmt.Fprintf(&b, "accp_http_request_duration_seconds_bucket{%s,le=\"+Inf\"} %d\naccp_http_request_duration_seconds_count{%s} %d\naccp_http_request_duration_seconds_sum{%s} %g\n", key, s.Count, key, s.Count, key, s.Sum)
	}
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	metrics := []struct{ name, query string }{
		{"outbox_pending", `SELECT count(*) FROM outbox_events WHERE delivered_at IS NULL`},
		{"outbox_oldest_seconds", `SELECT coalesce(extract(epoch FROM clock_timestamp()-min(created_at)),0) FROM outbox_events WHERE delivered_at IS NULL`},
		{"event_failures", `SELECT count(*) FROM event_failures WHERE resolved_at IS NULL`},
		{"worker_event_lag_seconds", `SELECT coalesce(extract(epoch FROM clock_timestamp()-max(event_at)),1e9) FROM worker_health`},
		{"worker_governance_lag_seconds", `SELECT coalesce(extract(epoch FROM clock_timestamp()-max(governance_at)),1e9) FROM worker_health`},
		{"runs_lease_expired", `SELECT count(*) FROM task_runs WHERE status='RUNNING' AND lease_expires_at<clock_timestamp()`},
		{"runs_lost", `SELECT count(*) FROM task_runs WHERE status='LOST'`},
		{"approvals_pending", `SELECT count(*) FROM approvals WHERE document->>'status'='PENDING'`},
		{"operations_unknown", `SELECT count(*) FROM tool_invocations WHERE status='UNKNOWN'`},
		{"maintenance", `SELECT maintenance::int FROM runtime_state WHERE id='default'`},
		{"recovery_pending", `SELECT count(*) FROM recovery_items WHERE resolved_at IS NULL`},
	}
	healthy := 1
	for _, metric := range metrics {
		var v float64
		if err := m.pool.QueryRow(ctx, metric.query).Scan(&v); err != nil {
			healthy = 0
			continue
		}
		fmt.Fprintf(&b, "# TYPE accp_%s gauge\naccp_%s %g\n", metric.name, metric.name, v)
	}
	fmt.Fprintf(&b, "# TYPE accp_database_up gauge\naccp_database_up %d\n", healthy)
	stats := m.pool.Stat()
	fmt.Fprintf(&b, "accp_database_pool_acquired %d\naccp_database_pool_max %d\n", stats.AcquiredConns(), stats.MaxConns())
	fmt.Fprint(w, b.String())
}

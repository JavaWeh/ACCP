package bridge

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/JavaWeh/ACCP/pkg/client"
)

const runIdleLimit = 30 * time.Minute

// HeartbeatStatus is local scheduling state, not an authorization decision.
// The control plane still validates every write, including idempotent replays.
type HeartbeatStatus struct {
	State                  string `json:"state"`
	Reason                 string `json:"reason,omitempty"`
	ContextUpdateAvailable bool   `json:"context_update_available"`
}

type leaseSet struct {
	c      apiCaller
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	runs   map[string]*runLease
}

type apiCaller interface {
	Call(context.Context, string, string, client.Object, client.WriteOptions) (client.Response, error)
}

type runLease struct {
	mu                    sync.Mutex // serializes ALL managed Run writes, including heartbeats
	id                    string
	version, floor, fence int64
	expires, lastUse      time.Time
	interval              time.Duration
	stopped               string
	contextUpdated        bool
	pending               *heartbeatWrite
	uncertainWrite        string
	writes                map[string]*runWrite
}

type heartbeatWrite struct {
	body    client.Object
	options client.WriteOptions
}

type runWrite struct {
	digest  [32]byte
	options client.WriteOptions
	applied bool
}

func newLeaseSet(c apiCaller) *leaseSet {
	ctx, cancel := context.WithCancel(context.Background())
	return &leaseSet{c: c, ctx: ctx, cancel: cancel, runs: make(map[string]*runLease)}
}

func (s *leaseSet) call(ctx context.Context, method, path string, in Input) (client.Response, *HeartbeatStatus, error) {
	s.mu.Lock()
	r := s.runs[in.ID]
	s.mu.Unlock()
	if r != nil && (path == "/task-runs/"+in.ID || strings.HasPrefix(path, "/task-runs/"+in.ID+"/")) {
		return s.runCall(ctx, r, method, path, in)
	}
	res, err := s.c.Call(ctx, method, path, in.Body, client.WriteOptions{IdempotencyKey: in.IdempotencyKey, Version: in.Version, FencingToken: in.FencingToken})
	if err == nil && path == "/task-runs/claim" {
		r = s.track(res.Body)
		if r == nil {
			return res, nil, errors.New("claimed Run has invalid lease metadata; inspect accp_run before proceeding")
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		return res, r.status(), nil
	}
	return res, nil, err
}

func (s *leaseSet) track(body client.Object) *runLease {
	run, ok := body["run"].(map[string]any)
	if !ok {
		return nil
	}
	id, _ := run["id"].(string)
	expires, err := time.Parse(time.RFC3339Nano, stringField(run, "lease_expires_at"))
	version, fence := intField(run, "version"), intField(run, "fencing_token")
	if !identifier.MatchString(id) || err != nil || version <= 0 || fence <= 0 || run["status"] != "RUNNING" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// A replayed claim must not reset a newer version or restart stopped renewal.
	if r := s.runs[id]; r != nil {
		return r
	}
	interval := time.Duration(intField(body, "heartbeat_interval_seconds")) * time.Second * 2 / 3
	if interval <= 0 || interval > 20*time.Second {
		interval = 20 * time.Second
	}
	r := &runLease{id: id, version: version, floor: version, fence: fence, expires: expires,
		lastUse: time.Now(), interval: interval, writes: make(map[string]*runWrite)}
	r.live(time.Now())
	s.runs[id] = r
	go s.maintain(r)
	return r
}

func (s *leaseSet) maintain(r *runLease) {
	delay := r.interval
	for {
		timer := time.NewTimer(delay)
		select {
		case <-s.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		r.mu.Lock()
		if s.ctx.Err() != nil || !r.live(time.Now()) {
			r.mu.Unlock()
			return
		}
		started := time.Now()
		if r.uncertainWrite == "" {
			s.renew(r)
		}
		delay = r.interval
		if r.pending != nil || r.uncertainWrite != "" {
			delay = 2 * time.Second
		}
		// Schedule from request start, not response receipt.
		delay -= time.Since(started)
		if delay < 10*time.Millisecond {
			delay = 10 * time.Millisecond
		}
		stopped := r.stopped != ""
		r.mu.Unlock()
		if stopped {
			return
		}
	}
}

// renew is called with r.mu held. Transient failures retain the entire original
// request, since a failed HTTP exchange may already have committed a heartbeat.
func (s *leaseSet) renew(r *runLease) {
	if r.pending == nil {
		r.pending = &heartbeatWrite{
			body:    client.Object{"observed_at": time.Now().UTC().Format(time.RFC3339Nano)},
			options: client.WriteOptions{IdempotencyKey: client.NewKey(), Version: r.version, FencingToken: r.fence},
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	if r.expires.Before(deadline) {
		deadline = r.expires
	}
	ctx, cancel := context.WithDeadline(s.ctx, deadline)
	defer cancel()
	res, err := s.c.Call(ctx, "POST", "/task-runs/"+r.id+"/heartbeat", r.pending.body, r.pending.options)
	if err != nil {
		if definitive(err) {
			r.stopped = "heartbeat refused; stop execution and inspect accp_run"
		}
		return
	}
	r.pending = nil
	r.observe(res.Body, false)
	if updated, ok := res.Body["context_update_available"].(bool); ok {
		r.contextUpdated = updated
	}
	if res.Body["cancel_requested"] == true {
		r.stopped = "cancellation requested; stop execution"
	}
}

func (s *leaseSet) runCall(ctx context.Context, r *runLease, method, path string, in Input) (client.Response, *HeartbeatStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if method == "GET" {
		res, err := s.c.Call(ctx, method, path, nil, client.WriteOptions{})
		if err == nil {
			// A read can discover external changes, but cannot authorize rebasing
			// writes or revive a stopped scheduler.
			if res.Body["status"] != "RUNNING" {
				r.stopped = "Run ended; stop execution"
			}
			r.live(time.Now())
			r.lastUse = time.Now()
		} else if terminalRefusal(err) {
			r.stopped = "Run read refused; stop execution and inspect accp_run"
		}
		return res, r.status(), err
	}
	key := path + "\x00" + in.IdempotencyKey
	raw, err := json.Marshal(in)
	if err != nil {
		return client.Response{}, r.status(), err
	}
	digest := sha256.Sum256(raw)
	w := r.writes[key]
	if w != nil && w.digest != digest {
		return client.Response{}, r.status(), errors.New("idempotency key already bound to different arguments; retry the original request")
	}
	if w != nil && !w.applied {
		// A previously rejected request is not a committed replay: the server
		// may execute it now. Do not let it pass an unrelated unknown write.
		if r.pending != nil || r.uncertainWrite != "" && r.uncertainWrite != key {
			return client.Response{}, r.status(), errors.New("Run write outcome unknown; reconcile the pending request first")
		}
		if r.uncertainWrite != key && (s.ctx.Err() != nil || !r.live(time.Now())) {
			return client.Response{}, r.status(), errors.New("automatic renewal stopped; stop execution and inspect accp_run")
		}
	}
	if w == nil {
		if s.ctx.Err() != nil || !r.live(time.Now()) {
			return client.Response{}, r.status(), errors.New("automatic renewal stopped; stop execution and inspect accp_run")
		}
		if r.pending != nil || r.uncertainWrite != "" {
			return client.Response{}, r.status(), errors.New("Run write outcome unknown; retry the original write or wait for heartbeat reconciliation")
		}
		if in.FencingToken != r.fence || in.Version < r.floor || in.Version > r.version {
			return client.Response{}, r.status(), errors.New("stale Run version or fencing token; inspect accp_run")
		}
		if len(in.IdempotencyKey) < 8 || len(r.writes) >= 4096 {
			return client.Response{}, r.status(), errors.New("stable idempotency key required and at most 4096 writes per managed Run")
		}
		w = &runWrite{digest: digest, options: client.WriteOptions{IdempotencyKey: in.IdempotencyKey, Version: r.version, FencingToken: in.FencingToken}}
		r.writes[key] = w
	}
	// Replays always reach the API with their original headers. Never serve a
	// local success cache that could bypass revocation or lease validation.
	res, err := s.c.Call(ctx, method, path, in.Body, w.options)
	if !w.applied {
		if err == nil || definitive(err) {
			if r.uncertainWrite == key {
				r.uncertainWrite = ""
			}
			if err == nil {
				w.applied = true
				if strings.HasSuffix(path, "/heartbeat") || strings.HasSuffix(path, "/reports") {
					r.observe(res.Body, true)
				}
			}
		} else {
			r.uncertainWrite = key
		}
	}
	if terminalRefusal(err) {
		r.stopped = "Run write refused; stop execution and inspect accp_run"
	}
	if err == nil {
		r.lastUse = time.Now()
	}
	return res, r.status(), err
}

func (r *runLease) observe(body client.Object, foreground bool) {
	run := body
	if nested, ok := body["run"].(map[string]any); ok {
		run = nested
	}
	version := intField(run, "version")
	expires, err := time.Parse(time.RFC3339Nano, stringField(run, "lease_expires_at"))
	if run["id"] != r.id || intField(run, "fencing_token") != r.fence || version < r.version || err != nil {
		r.stopped = "invalid Run response; stop execution and inspect accp_run"
		return
	}
	r.version, r.expires = version, expires
	if foreground {
		r.floor = version
	}
	if run["status"] != "RUNNING" {
		r.stopped = "Run ended; stop execution"
	}
}

func (r *runLease) live(now time.Time) bool {
	if r.stopped == "" {
		switch {
		case !now.Before(r.expires):
			r.stopped = "lease expired; stop execution"
		case now.Sub(r.lastUse) >= runIdleLimit:
			r.stopped = "Run tool idle limit reached; stop execution"
		}
	}
	return r.stopped == ""
}

func (r *runLease) status() *HeartbeatStatus {
	state := "running"
	if r.pending != nil || r.uncertainWrite != "" {
		state = "uncertain"
	}
	if r.stopped != "" {
		state = "stopped"
	}
	return &HeartbeatStatus{State: state, Reason: r.stopped, ContextUpdateAvailable: r.contextUpdated}
}

func definitive(err error) bool {
	var api *client.Error
	return errors.As(err, &api) && api.Status >= 400 && api.Status < 500 && api.Status != 408 && api.Status != 429
}

func terminalRefusal(err error) bool {
	var api *client.Error
	return errors.As(err, &api) && (api.Status == 401 || api.Status == 403 || api.Status == 404 || api.Status == 412 || api.Code == "RUN_INACTIVE" || api.Code == "STALE_FENCE")
}

func stringField(o client.Object, key string) string {
	v, _ := o[key].(string)
	return v
}

func intField(o client.Object, key string) int64 {
	v, _ := o[key].(float64)
	return int64(v)
}

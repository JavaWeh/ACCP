package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/JavaWeh/ACCP/pkg/client"
)

type leaseRequest struct {
	path string
	body string
	opts client.WriteOptions
}

// leaseAPI models server-side CAS, fencing and idempotency, with controllable
// ambiguous outcomes. synctest lets these tests span full leases without sleeps
// in wall-clock time. Real HTTP, PostgreSQL and stdio are covered by integration.
type leaseAPI struct {
	mu                    sync.Mutex
	run                   client.Object
	requests              []leaseRequest
	cache                 map[string]client.Response
	bound                 map[string]leaseRequest
	failBefore, failAfter int
	refusal               *client.Error
	contextUpdated        bool
	delay                 time.Duration
	entered               chan struct{}
	rejectOnce            bool
}

func newLeaseAPI() *leaseAPI {
	return &leaseAPI{run: client.Object{"id": "run_test", "version": float64(1), "fencing_token": float64(7), "status": "RUNNING", "lease_expires_at": time.Now().Add(90 * time.Second).UTC().Format(time.RFC3339Nano)}, cache: make(map[string]client.Response), bound: make(map[string]leaseRequest)}
}

func copyObject(o client.Object) client.Object {
	raw, _ := json.Marshal(o)
	var copy client.Object
	_ = json.Unmarshal(raw, &copy)
	return copy
}

func (f *leaseAPI) configure(change func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change()
}

func (f *leaseAPI) recorded() []leaseRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]leaseRequest(nil), f.requests...)
}

func (f *leaseAPI) version() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return intField(f.run, "version")
}

func (f *leaseAPI) Call(ctx context.Context, method, path string, body client.Object, opts client.WriteOptions) (client.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refusal != nil {
		return client.Response{}, f.refusal
	}
	if method == "GET" {
		return client.Response{Status: 200, Body: copyObject(f.run)}, nil
	}
	if path == "/task-runs/claim" {
		return client.Response{Status: 201, Body: client.Object{"run": copyObject(f.run), "heartbeat_interval_seconds": float64(30)}}, nil
	}
	raw, _ := json.Marshal(body)
	req := leaseRequest{path: path, body: string(raw), opts: opts}
	f.requests = append(f.requests, req)
	if f.entered != nil {
		select {
		case f.entered <- struct{}{}:
		default:
		}
	}
	key := path + ":" + opts.IdempotencyKey
	if bound, ok := f.bound[key]; ok && bound != req {
		return client.Response{}, &client.Error{Status: 409, Code: "IDEMPOTENCY_CONFLICT"}
	}
	f.bound[key] = req
	if f.delay > 0 {
		select {
		case <-ctx.Done():
			return client.Response{}, ctx.Err()
		case <-time.After(f.delay):
		}
	}
	if f.failBefore > 0 {
		f.failBefore--
		return client.Response{}, errors.New("connection unavailable")
	}
	if cached, ok := f.cache[key]; ok {
		return cached, nil
	}
	expires, _ := time.Parse(time.RFC3339Nano, stringField(f.run, "lease_expires_at"))
	if f.run["status"] != "RUNNING" || !time.Now().Before(expires) {
		return client.Response{}, &client.Error{Status: 409, Code: "RUN_INACTIVE"}
	}
	if opts.FencingToken != intField(f.run, "fencing_token") {
		return client.Response{}, &client.Error{Status: 409, Code: "STALE_FENCE"}
	}
	if opts.Version != intField(f.run, "version") {
		return client.Response{}, &client.Error{Status: 412, Code: "VERSION_CONFLICT"}
	}
	if f.rejectOnce {
		f.rejectOnce = false
		return client.Response{}, &client.Error{Status: 422, Code: "ARTIFACT_EVIDENCE_REQUIRED"}
	}
	res := client.Response{Status: 200, Body: client.Object{"uri": "urn:accp:artifact-content:test"}}
	if strings.HasSuffix(path, "/heartbeat") || strings.HasSuffix(path, "/reports") {
		f.run["version"] = float64(intField(f.run, "version") + 1)
		if strings.HasSuffix(path, "/heartbeat") {
			f.run["lease_expires_at"] = time.Now().Add(90 * time.Second).UTC().Format(time.RFC3339Nano)
			res.Body = client.Object{"run": copyObject(f.run), "context_update_available": f.contextUpdated}
		} else {
			if body["kind"] == "COMPLETION_CANDIDATE" {
				f.run["status"] = "SUCCEEDED"
			}
			if body["kind"] == "FAILURE" {
				f.run["status"] = "FAILED"
			}
			res.Body = copyObject(f.run)
		}
	}
	f.cache[key] = res
	if f.failAfter > 0 {
		f.failAfter--
		return client.Response{}, errors.New("response lost after commit")
	}
	return res, nil
}

func claimedLease(t *testing.T) (*leaseSet, *leaseAPI, Input) {
	t.Helper()
	f := newLeaseAPI()
	s := newLeaseSet(f)
	_, status, err := s.call(context.Background(), "POST", "/task-runs/claim", Input{IdempotencyKey: "claim-key"})
	if err != nil || status.State != "running" {
		t.Fatalf("claim: %v %+v", err, status)
	}
	synctest.Wait()
	return s, f, Input{ID: "run_test", Version: 1, FencingToken: 7, IdempotencyKey: "write-key", Body: client.Object{"kind": "PROGRESS"}}
}

func advance(d time.Duration) { time.Sleep(d); synctest.Wait() }

func TestAutomaticRenewalDuringApprovalWait(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, f, in := claimedLease(t)
		defer s.cancel()
		f.configure(func() { f.contextUpdated = true })
		advance(2 * time.Minute) // no tool call for longer than the original lease
		if len(f.recorded()) != 6 {
			t.Fatalf("heartbeats: %d", len(f.recorded()))
		}
		res, status, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in)
		if err != nil || intField(res.Body, "version") != 8 || !status.ContextUpdateAvailable {
			t.Fatalf("write using claim version after idle renewal: %v %+v %+v", err, res, status)
		}
		// The foreground report is a real state change, so its old version is
		// no longer eligible for heartbeat-only rebasing.
		in.IdempotencyKey = "stale-report-key"
		if _, _, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err == nil {
			t.Fatal("rebased past a foreground report")
		}
	})
}

func TestHeartbeatRetriesOriginalRequestAfterUnknownOutcome(t *testing.T) {
	for _, afterCommit := range []bool{false, true} {
		t.Run(fmt.Sprint(afterCommit), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				s, f, in := claimedLease(t)
				defer s.cancel()
				f.configure(func() {
					if afterCommit {
						f.failAfter = 1
					} else {
						f.failBefore = 1
					}
				})
				advance(20 * time.Second)
				if _, status, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err == nil || status.State != "uncertain" {
					t.Fatal("write raced unknown heartbeat")
				}
				advance(2 * time.Second)
				if len(f.recorded()) != 2 || f.recorded()[0] != f.recorded()[1] {
					t.Fatal("heartbeat retry changed key, body, version or fence")
				}
				if f.version() != 2 {
					t.Fatal("heartbeat applied twice")
				}
				if _, _, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err != nil {
					t.Fatal(err)
				}
			})
		})
	}
}

func TestWriteReplayPreservesTranslatedVersion(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, f, in := claimedLease(t)
		defer s.cancel()
		advance(20 * time.Second)
		path := "/task-runs/run_test/artifact-contents"
		if _, _, err := s.call(context.Background(), "POST", path, in); err != nil {
			t.Fatal(err)
		}
		original := f.recorded()[len(f.recorded())-1]
		advance(20 * time.Second)
		if _, _, err := s.call(context.Background(), "POST", path, in); err != nil {
			t.Fatal(err)
		}
		if original != f.recorded()[len(f.recorded())-1] || original.opts.Version != 2 {
			t.Fatal("replay used a different wire request")
		}
		in.Body = client.Object{"content": "changed"}
		if _, _, err := s.call(context.Background(), "POST", path, in); err == nil {
			t.Fatal("changed body accepted with same key")
		}
	})
}

func TestUncertainReportPausesRenewalUntilExactRetry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, f, in := claimedLease(t)
		defer s.cancel()
		f.configure(func() { f.failAfter = 1 })
		if _, _, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err == nil {
			t.Fatal("missing simulated timeout")
		}
		advance(40 * time.Second)
		if len(f.recorded()) != 1 {
			t.Fatal("renewed across unknown foreground write")
		}
		if _, _, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err != nil {
			t.Fatal(err)
		}
		if f.recorded()[0] != f.recorded()[1] {
			t.Fatal("ambiguous report retry changed")
		}
		advance(2 * time.Second)
		if f.version() != 3 {
			t.Fatal("renewal did not resume after reconciliation")
		}
	})
}

func TestRejectedRequestCannotPassAnUncertainWrite(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, f, in := claimedLease(t)
		defer s.cancel()
		f.configure(func() { f.rejectOnce = true })
		path := "/task-runs/run_test/reports"
		if _, _, err := s.call(context.Background(), "POST", path, in); err == nil {
			t.Fatal("missing evidence rejection")
		}
		pending := in
		pending.IdempotencyKey = "pending-report-key"
		f.configure(func() { f.failAfter = 1 })
		if _, _, err := s.call(context.Background(), "POST", path, pending); err == nil {
			t.Fatal("missing ambiguous report")
		}
		if _, _, err := s.call(context.Background(), "POST", path, in); err == nil {
			t.Fatal("rejected request was treated as a committed replay")
		}
		if len(f.recorded()) != 2 {
			t.Fatal("unrelated request reached the API before reconciliation")
		}
		if _, _, err := s.call(context.Background(), "POST", path, pending); err != nil {
			t.Fatal(err)
		}
	})
}

func TestHeartbeatRequestTimeoutRetainsItsIdentity(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, f, _ := claimedLease(t)
		defer s.cancel()
		f.configure(func() { f.delay = 8 * time.Second })
		advance(25 * time.Second) // heartbeat starts at 20s, times out at 25s
		if len(f.recorded()) != 1 || f.version() != 1 {
			t.Fatal("heartbeat deadline did not bound the slow request")
		}
		f.configure(func() { f.delay = 0 })
		advance(20 * time.Millisecond)
		calls := f.recorded()
		if len(calls) != 2 || calls[0] != calls[1] || f.version() != 2 {
			t.Fatal("timeout retry changed the request or applied twice")
		}
	})
}

func TestRenewalStopsOnAuthorityRefusal(t *testing.T) {
	for _, refusal := range []*client.Error{{Status: 401, Code: "SESSION_INACTIVE"}, {Status: 403, Code: "OWNER_INACTIVE"}, {Status: 409, Code: "RUN_INACTIVE"}, {Status: 409, Code: "STALE_FENCE"}, {Status: 412, Code: "VERSION_CONFLICT"}} {
		t.Run(refusal.Code, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				s, f, in := claimedLease(t)
				defer s.cancel()
				f.configure(func() { f.refusal = refusal })
				advance(20 * time.Second)
				f.configure(func() { f.refusal = nil })
				advance(time.Minute)
				if len(f.recorded()) != 0 {
					t.Fatal("restarted refused renewal")
				}
				if _, status, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err == nil || status.State != "stopped" {
					t.Fatal("write allowed after renewal stopped")
				}
			})
		})
	}
}

func TestNetworkOutageDoesNotReviveExpiredLease(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, f, in := claimedLease(t)
		defer s.cancel()
		f.configure(func() { f.failBefore = 1000 })
		advance(100 * time.Second)
		count := len(f.recorded())
		f.configure(func() { f.failBefore = 0 })
		advance(time.Minute)
		if count != len(f.recorded()) {
			t.Fatal("renewed after original lease expired")
		}
		if _, _, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err == nil {
			t.Fatal("accepted old Run after outage")
		}
	})
}

func TestCompletionAndFailureStopRenewalButPermitExactReplay(t *testing.T) {
	for _, kind := range []string{"COMPLETION_CANDIDATE", "FAILURE"} {
		t.Run(kind, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				s, f, in := claimedLease(t)
				defer s.cancel()
				in.Body = client.Object{"kind": kind}
				if _, status, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err != nil || status.State != "stopped" {
					t.Fatalf("terminal: %v %+v", err, status)
				}
				advance(time.Minute)
				if len(f.recorded()) != 1 {
					t.Fatal("renewed terminal Run")
				}
				if _, _, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err != nil {
					t.Fatal(err)
				}
				if f.recorded()[0] != f.recorded()[1] {
					t.Fatal("terminal replay changed")
				}
				f.configure(func() { f.refusal = &client.Error{Status: 401, Code: "SESSION_INACTIVE"} })
				if _, _, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err == nil {
					t.Fatal("local replay bypassed revocation")
				}
			})
		})
	}
}

func TestSessionCloseAndIdleLimitStopRenewal(t *testing.T) {
	for _, idle := range []bool{false, true} {
		t.Run(fmt.Sprint(idle), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				s, f, in := claimedLease(t)
				defer s.cancel()
				if idle {
					advance(runIdleLimit)
				} else {
					s.cancel()
					synctest.Wait()
				}
				count := len(f.recorded())
				advance(time.Minute)
				if len(f.recorded()) != count {
					t.Fatal("renewed abandoned Run")
				}
				// Reading does not restart a stopped scheduler.
				_, _, _ = s.call(context.Background(), "GET", "/task-runs/run_test", in)
				advance(20 * time.Second)
				if len(f.recorded()) != count {
					t.Fatal("read revived stopped renewal")
				}
			})
		})
	}
}

func TestConcurrentWritesAndSlowHeartbeatAreSerialized(t *testing.T) {
	// Mutex waits are not durably blocked under synctest. Exercise real
	// contention with a short delayed API response and explicit barriers.
	f := newLeaseAPI()
	f.delay = 20 * time.Millisecond
	f.entered = make(chan struct{}, 1)
	s := newLeaseSet(f)
	defer s.cancel()
	r := s.track(client.Object{"run": copyObject(f.run)})
	in := Input{ID: "run_test", Version: 1, FencingToken: 7, Body: client.Object{"content": "test"}}
	done := make(chan struct{})
	go func() { defer close(done); r.mu.Lock(); defer r.mu.Unlock(); s.renew(r) }()
	<-f.entered // heartbeat owns the Run lock
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			input := in
			input.IdempotencyKey = fmt.Sprintf("upload-key-%d", i)
			if _, _, err := s.call(context.Background(), "POST", "/task-runs/run_test/artifact-contents", input); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	<-done
	if len(f.recorded()) != 5 {
		t.Fatalf("writes: %d", len(f.recorded()))
	}
	for _, req := range f.recorded()[1:] {
		if req.opts.Version != 2 {
			t.Fatal("write raced heartbeat version")
		}
	}
}

func TestClaimReplayAndWrongFenceDoNotResetLease(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, f, in := claimedLease(t)
		defer s.cancel()
		advance(20 * time.Second)
		in.FencingToken++
		if _, _, err := s.call(context.Background(), "POST", "/task-runs/run_test/reports", in); err == nil {
			t.Fatal("wrong fence accepted")
		}
		s.track(client.Object{"run": client.Object{"id": "run_test", "version": float64(1), "fencing_token": float64(7), "status": "RUNNING", "lease_expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)}})
		advance(20 * time.Second)
		if f.version() != 3 {
			t.Fatal("replayed claim reset version or duplicated scheduling")
		}
	})
}

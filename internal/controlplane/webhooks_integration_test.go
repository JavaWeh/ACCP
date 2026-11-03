//go:build integration

package controlplane

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JavaWeh/ACCP/internal/auth"
)

var webhookKey = bytes.Repeat([]byte{31}, 32)

// setupWebhooks rebuilds the fixture server with a signer, an allowlist and the
// WebhookInsecure test seam so delivery can POST to a loopback httptest.Server.
func setupWebhooks(t *testing.T, insecure bool) *fixture {
	f := setup(t)
	var err error
	f.server, err = New(f.pool, testAuth{}, Options{SessionKey: webhookKey, PublicURL: "http://127.0.0.1:18080", WebhookAllowlist: []string{"example.com"}, WebhookInsecure: insecure})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func webhookSigner(t *testing.T) *auth.SessionSigner {
	s, err := auth.NewSessionSigner(webhookKey)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func seedEndpoint(t *testing.T, f *fixture, url string, events []string, sealed string) string {
	id := newID("webhook")
	_, err := f.pool.Exec(context.Background(), `INSERT INTO webhook_endpoints(id,organization_id,project_id,url,event_types,signing_secret,created_by_user_id,delivered_sequence) VALUES($1,'org_demo','project_demo',$2,$3,$4,'user_alice',0)`, id, url, events, sealed)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func seedEvent(t *testing.T, f *fixture, kind string, data Object) {
	id := newID("event")
	data["organization_id"] = "org_demo"
	data["project_id"] = "project_demo"
	event := Object{"specversion": "1.0", "id": id, "source": "urn:accp:control-plane", "type": "io.accp." + kind + ".v1", "subject": textValue(data, "task_id"), "time": now(), "datacontenttype": "application/json", "data": data}
	raw, _ := json.Marshal(event)
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `INSERT INTO outbox_events(id,project_id,organization_id,event,delivered_at) VALUES($1,'project_demo','org_demo',$2,now())`, id, raw); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO event_feed(event_id,project_id,organization_id,event) VALUES($1,'project_demo','org_demo',$2)`, id, raw); err != nil {
		t.Fatal(err)
	}
}

func TestWebhookCreateAuthorizationAndValidation(t *testing.T) {
	f := setupWebhooks(t, false)
	body := Object{"url": "https://hooks.example.com/accp", "event_types": []string{"REVIEW_REQUIRED"}, "reason": "Deliver reviews to the team hook."}
	// A project MEMBER/REVIEWER (bob) is not an ADMIN.
	f.expect(f.call("bob", "POST", "/projects/project_demo/webhooks", newID("key"), "", body), 403, "")
	// Off-allowlist and non-HTTPS targets are rejected before any secret is stored.
	f.expect(f.call("alice", "POST", "/projects/project_demo/webhooks", newID("key"), "", Object{"url": "https://evil.test/accp", "event_types": []string{"REVIEW_REQUIRED"}, "reason": "off allowlist"}), 400, "")
	f.expect(f.call("alice", "POST", "/projects/project_demo/webhooks", newID("key"), "", Object{"url": "http://hooks.example.com/accp", "event_types": []string{"REVIEW_REQUIRED"}, "reason": "plain http"}), 400, "")

	webhookResolve = func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("93.184.216.34")}, nil }
	defer func() { webhookResolve = nil }()
	created := f.expect(f.call("alice", "POST", "/projects/project_demo/webhooks", newID("key"), "", body), 201, "ManagementWebhook")
	if textValue(created, "signing_secret") == "" {
		t.Fatal("create did not echo the signing secret once")
	}
	wid := textValue(created, "id")
	// The secret is echoed only on create; the list must never include it.
	listed := f.expect(f.call("alice", "GET", "/projects/project_demo/webhooks", "", "", nil), 200, "ManagementWebhookPage")
	items := listed["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected one webhook, got %d", len(items))
	}
	if _, present := items[0].(map[string]any)["signing_secret"]; present {
		t.Fatal("list leaked the signing secret")
	}
	// Carol administers project_secret, never project_demo's endpoint: cross-project is 404.
	f.expect(f.call("carol", "POST", "/projects/project_secret/webhooks/"+wid+"/changes", newID("key"), `"1"`, Object{"enabled": false, "reason": "cross project"}), 404, "")
}

func TestWebhookDeliverySignsAndRedacts(t *testing.T) {
	f := setupWebhooks(t, true)
	var count int32
	var gotEvent, gotSig, gotTS string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&count, 1)
		gotEvent = r.Header.Get("X-ACCP-Event")
		gotSig = r.Header.Get("X-ACCP-Signature")
		gotTS = r.Header.Get("X-ACCP-Timestamp")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(204)
	}))
	defer srv.Close()
	secret := "whsec_delivery"
	sealed, err := webhookSigner(t).SealSecret("webhook_signing_secret", secret)
	if err != nil {
		t.Fatal(err)
	}
	seedEndpoint(t, f, srv.URL, []string{"REVIEW_REQUIRED"}, sealed)
	seedEvent(t, f, "REVIEW_REQUIRED", Object{"task_id": "task_1", "owner_user_id": "user_bob", "token": "leak-me"})
	// A non-subscribed event must not be delivered.
	seedEvent(t, f, "TASK_STARTED", Object{"task_id": "task_2", "token": "also-leak"})

	if err := f.server.DeliverWebhooks(context.Background()); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&count) != 1 {
		t.Fatalf("expected exactly one delivery, got %d", count)
	}
	if gotEvent != "REVIEW_REQUIRED" {
		t.Fatalf("unexpected event header %q", gotEvent)
	}
	ts, _ := strconv.ParseInt(gotTS, 10, 64)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10)))
	mac.Write([]byte("."))
	mac.Write(gotBody)
	if gotSig != "sha256="+hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("signature did not verify against the shared secret")
	}
	var payload map[string]any
	if json.Unmarshal(gotBody, &payload) != nil {
		t.Fatal("payload was not JSON")
	}
	data := payload["data"].(map[string]any)
	if data["task_id"] != "task_1" {
		t.Fatal("whitelisted task_id missing from payload")
	}
	if _, present := data["token"]; present {
		t.Fatal("sensitive token leaked in delivered payload")
	}
	var delivered int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM webhook_deliveries WHERE delivered_at IS NOT NULL AND last_status=204`).Scan(&delivered); err != nil {
		t.Fatal(err)
	}
	if delivered != 1 {
		t.Fatalf("expected one delivered row, got %d", delivered)
	}
}

func TestWebhookFanoutIdempotentAndNoBackfill(t *testing.T) {
	f := setupWebhooks(t, true)
	var count int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&count, 1)
		w.WriteHeader(200)
	}))
	defer srv.Close()
	// An event that predates the endpoint must never be backfilled.
	seedEvent(t, f, "REVIEW_REQUIRED", Object{"task_id": "task_old"})
	sealed, _ := webhookSigner(t).SealSecret("webhook_signing_secret", "whsec_x")
	var cursor int64
	if err := f.pool.QueryRow(context.Background(), `SELECT coalesce(max(sequence),0) FROM event_feed WHERE project_id='project_demo'`).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	id := newID("webhook")
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO webhook_endpoints(id,organization_id,project_id,url,event_types,signing_secret,created_by_user_id,delivered_sequence) VALUES($1,'org_demo','project_demo',$2,$3,$4,'user_alice',$5)`, id, srv.URL, []string{"REVIEW_REQUIRED"}, sealed, cursor); err != nil {
		t.Fatal(err)
	}
	seedEvent(t, f, "REVIEW_REQUIRED", Object{"task_id": "task_new"})

	ctx := context.Background()
	if err := f.server.DeliverWebhooks(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.server.DeliverWebhooks(ctx); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM webhook_deliveries`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("expected one delivery (future event only, no duplicates), got %d", rows)
	}
}

func TestWebhookRetryBackoffThenSucceeds(t *testing.T) {
	f := setupWebhooks(t, true)
	var count int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&count, 1) == 1 {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()
	sealed, _ := webhookSigner(t).SealSecret("webhook_signing_secret", "whsec_retry")
	seedEndpoint(t, f, srv.URL, []string{"REVIEW_REQUIRED"}, sealed)
	seedEvent(t, f, "REVIEW_REQUIRED", Object{"task_id": "task_r"})
	ctx := context.Background()
	if err := f.server.DeliverWebhooks(ctx); err != nil {
		t.Fatal(err)
	}
	var attempts int
	var deliveredAt *time.Time
	var errCode *string
	if err := f.pool.QueryRow(ctx, `SELECT attempts,delivered_at,last_error_code FROM webhook_deliveries`).Scan(&attempts, &deliveredAt, &errCode); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || deliveredAt != nil || errCode == nil || *errCode != "HTTP_5XX" {
		t.Fatalf("expected one failed attempt pending retry, got attempts=%d delivered=%v err=%v", attempts, deliveredAt, errCode)
	}
	// The backoff pushed next_attempt_at into the future; make it due again.
	if _, err := f.pool.Exec(ctx, `UPDATE webhook_deliveries SET next_attempt_at=now()`); err != nil {
		t.Fatal(err)
	}
	if err := f.server.DeliverWebhooks(ctx); err != nil {
		t.Fatal(err)
	}
	var delivered int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM webhook_deliveries WHERE delivered_at IS NOT NULL AND last_status=200 AND attempts=2`).Scan(&delivered); err != nil {
		t.Fatal(err)
	}
	if delivered != 1 {
		t.Fatalf("expected eventual success after retry, got %d", delivered)
	}
}

func TestWebhookDeliveryTimeSSRFBlock(t *testing.T) {
	// A server WITHOUT the insecure seam re-validates the URL at delivery time.
	f := setupWebhooks(t, false)
	var count int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&count, 1)
		w.WriteHeader(200)
	}))
	defer srv.Close()
	sealed, _ := webhookSigner(t).SealSecret("webhook_signing_secret", "whsec_ssrf")
	// srv.URL is loopback http — never on the allowlist, never resolvable to a public IP.
	seedEndpoint(t, f, srv.URL, []string{"REVIEW_REQUIRED"}, sealed)
	seedEvent(t, f, "REVIEW_REQUIRED", Object{"task_id": "task_s"})
	if err := f.server.DeliverWebhooks(context.Background()); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&count) != 0 {
		t.Fatal("a blocked destination must receive no request")
	}
	var code string
	if err := f.pool.QueryRow(context.Background(), `SELECT last_error_code FROM webhook_deliveries`).Scan(&code); err != nil {
		t.Fatal(err)
	}
	if code != "SSRF_BLOCKED" {
		t.Fatalf("expected SSRF_BLOCKED, got %q", code)
	}
}

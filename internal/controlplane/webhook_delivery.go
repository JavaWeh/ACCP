package controlplane

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

// Serializes webhook fan-out across worker processes (distinct from the event
// relay lock 1094927185 and the feed lock 1094927186).
const webhookFanoutLock = 1094927187

// webhookAttemptCeiling abandons a delivery after this many failed attempts
// rather than retrying forever (aligned with "approval never implies infinite
// retry"). The UI distinguishes "retrying" from "given up" via abandoned_at.
const webhookAttemptCeiling = 10

// webhookBatch bounds how many events a single fan-out pass reads per endpoint
// and how many due deliveries a single dispatch pass attempts, so a slow
// receiver can never stall the shared worker ticker.
const webhookBatch = 500
const webhookDispatchBatch = 20

var errSSRFBlocked = errors.New("destination resolves to a blocked address")
var errRedirectDenied = errors.New("redirect denied")

// webhookResolve is the name resolver used by the configuration-time SSRF gate.
// nil means the default resolver (real DNS); a test overrides it to assert the
// gate deterministically without network access.
var webhookResolve func(context.Context, string) ([]net.IP, error)

// webhookKindEvent reverses webhookEventKind: internal event kind -> user-facing
// subscription name. Built once so fan-out can decide, for one feed event,
// which subscription name (if any) it satisfies.
var webhookKindEvent = func() map[string]string {
	m := map[string]string{}
	for name, kind := range webhookEventKind {
		m[kind] = name
	}
	return m
}()

// webhookTopLevel is the CloudEvents envelope projection kept in a delivery.
var webhookTopLevel = map[string]bool{
	"specversion": true, "id": true, "type": true, "source": true,
	"subject": true, "time": true, "datacontenttype": true,
}

// webhookDataFields is the field whitelist for the event data object. Only ids,
// digests, decisions and status summaries are forwarded; a field not listed
// here (and any future free-text or body field) is dropped so it can never
// leak. Any *_user_id is also kept (actor/owner references carry no secret).
var webhookDataFields = map[string]bool{
	"task_id": true, "task_run_id": true, "context_snapshot_id": true,
	"artifact_id": true, "artifact_ids": true, "approval_id": true,
	"invocation_id": true, "assignment_id": true, "session_id": true,
	"execution_session_id": true, "decision": true, "error_code": true,
	"run_status": true, "status": true, "content_digest": true,
	"immutable_revision": true, "binding_digest": true,
	"organization_id": true, "project_id": true, "aggregate_id": true,
	"aggregate_version": true, "correlation_id": true, "causation_id": true,
}

func webhookFieldAllowed(key string) bool {
	return webhookDataFields[key] || strings.HasSuffix(key, "_user_id")
}

// redactEvent projects a CloudEvents envelope onto the field whitelist. It is a
// pure function so a unit test can assert an injected sensitive field is
// stripped while whitelisted ids survive.
func redactEvent(event map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range event {
		if webhookTopLevel[key] {
			out[key] = value
		}
	}
	if data, ok := event["data"].(map[string]any); ok {
		redacted := map[string]any{}
		for key, value := range data {
			if webhookFieldAllowed(key) {
				redacted[key] = value
			}
		}
		out["data"] = redacted
	}
	return out
}

func newWebhookSecret(s *Server) (plaintext, sealed string, err error) {
	var raw [32]byte
	if _, err = rand.Read(raw[:]); err != nil {
		return "", "", err
	}
	plaintext = "whsec_" + base64.RawURLEncoding.EncodeToString(raw[:])
	sealed, err = s.signer.SealSecret("webhook_signing_secret", plaintext)
	return plaintext, sealed, err
}

// signWebhook builds the signature header value sha256=<hex HMAC>, over
// "<timestamp>.<body>" so a captured delivery cannot be replayed under a
// different time.
func signWebhook(secret string, timestamp int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strconv.FormatInt(timestamp, 10)))
	_, _ = mac.Write([]byte("."))
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// blockedIP rejects loopback, RFC1918 / unique-local private ranges, link-local
// (which includes the 169.254.169.254 cloud metadata address and fe80::),
// unspecified and multicast destinations.
func blockedIP(ip net.IP) bool {
	return ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() ||
		ip.Equal(net.IPv4(169, 254, 169, 254))
}

// allowlistHost reports whether host is covered by an operator allowlist entry,
// matching the entry exactly or as a parent domain suffix. An empty allowlist
// matches nothing: outbound delivery is disabled until an operator opts in.
func allowlistHost(host string, allowlist []string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, entry := range allowlist {
		entry = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(entry), ".")))
		if entry == "" {
			continue
		}
		if host == entry || strings.HasSuffix(host, "."+entry) {
			return true
		}
	}
	return false
}

// validateWebhookURL enforces the configuration-time SSRF gate: HTTPS only, no
// credentials or fragment, host on the allowlist, and every resolved IP public.
// resolve is injectable for tests; nil uses the default resolver.
func validateWebhookURL(ctx context.Context, raw string, allowlist []string, resolve func(context.Context, string) ([]net.IP, error)) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return fail(400, "WEBHOOK_URL_REJECTED", "Use an HTTPS URL without credentials or fragment.")
	}
	host := u.Hostname()
	if host == "" {
		return fail(400, "WEBHOOK_URL_REJECTED", "A webhook URL requires a host.")
	}
	if !allowlistHost(host, allowlist) {
		return fail(400, "WEBHOOK_URL_REJECTED", "The destination host is not on the operator allowlist.")
	}
	if resolve == nil {
		resolve = func(ctx context.Context, h string) ([]net.IP, error) {
			return net.DefaultResolver.LookupIP(ctx, "ip", h)
		}
	}
	ips, err := resolve(ctx, host)
	if err != nil || len(ips) == 0 {
		return fail(400, "WEBHOOK_URL_REJECTED", "The destination host could not be resolved.")
	}
	for _, ip := range ips {
		if blockedIP(ip) {
			return fail(400, "WEBHOOK_URL_REJECTED", "The destination resolves to a private or reserved address.")
		}
	}
	return nil
}

// webhookClient builds a delivery client whose dialer re-validates the actual
// connect IP after resolution (closing the DNS-rebinding / TOCTOU window) and
// which refuses redirects. WebhookInsecure relaxes the private-IP block for
// tests only; it is never set from configuration.
func (s *Server) webhookClient() *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	if !s.options.WebhookInsecure {
		dialer.Control = func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if blockedIP(net.ParseIP(host)) {
				return errSSRFBlocked
			}
			return nil
		}
	}
	return &http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errRedirectDenied },
		Transport: &http.Transport{
			DialContext:         dialer.DialContext,
			TLSHandshakeTimeout: 10 * time.Second,
			DisableKeepAlives:   true,
		},
	}
}

// DeliverWebhooks runs one fan-out pass (enqueue new feed events for each
// enabled endpoint) followed by one dispatch pass (POST due deliveries). It is
// invoked from the worker ticker beside Reconcile/ProcessTools.
func (s *Server) DeliverWebhooks(ctx context.Context) error {
	if s.signer == nil {
		return nil
	}
	if err := s.fanoutWebhooks(ctx); err != nil {
		return err
	}
	return s.dispatchWebhooks(ctx)
}

type webhookEndpoint struct {
	id, project string
	events      []string
	cursor      int64
}

func (s *Server) fanoutWebhooks(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, webhookFanoutLock).Scan(&locked); err != nil || !locked {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id,project_id,event_types,delivered_sequence FROM webhook_endpoints WHERE enabled ORDER BY id`)
	if err != nil {
		return err
	}
	endpoints := []webhookEndpoint{}
	for rows.Next() {
		var e webhookEndpoint
		if err = rows.Scan(&e.id, &e.project, &e.events, &e.cursor); err != nil {
			rows.Close()
			return err
		}
		endpoints = append(endpoints, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, e := range endpoints {
		subscribed := map[string]bool{}
		for _, name := range e.events {
			subscribed[name] = true
		}
		feed, err := tx.Query(ctx, `SELECT sequence,event_id,event FROM event_feed WHERE project_id=$1 AND sequence>$2 AND recorded_at>now()-interval '7 days' ORDER BY sequence LIMIT $3`, e.project, e.cursor, webhookBatch)
		if err != nil {
			return err
		}
		type pending struct {
			sequence  int64
			eventID   string
			eventType string
			payload   []byte
		}
		queue := []pending{}
		maxSeq := e.cursor
		for feed.Next() {
			var sequence int64
			var eventID string
			var raw []byte
			if err = feed.Scan(&sequence, &eventID, &raw); err != nil {
				feed.Close()
				return err
			}
			if sequence > maxSeq {
				maxSeq = sequence
			}
			var event map[string]any
			if json.Unmarshal(raw, &event) != nil {
				continue
			}
			kind := strings.TrimSuffix(strings.TrimPrefix(textValue(event, "type"), "io.accp."), ".v1")
			name, mapped := webhookKindEvent[kind]
			if !mapped || !subscribed[name] {
				continue
			}
			payload, _ := json.Marshal(redactEvent(event))
			queue = append(queue, pending{sequence, eventID, name, payload})
		}
		err = feed.Err()
		feed.Close()
		if err != nil {
			return err
		}
		for _, p := range queue {
			if _, err = tx.Exec(ctx, `INSERT INTO webhook_deliveries(id,endpoint_id,organization_id,project_id,event_id,event_sequence,event_type,payload) SELECT $1,$2,organization_id,project_id,$3,$4,$5,$6 FROM webhook_endpoints WHERE id=$2 ON CONFLICT(endpoint_id,event_id) DO NOTHING`,
				newID("whd"), e.id, p.eventID, p.sequence, p.eventType, p.payload); err != nil {
				return err
			}
		}
		if maxSeq > e.cursor {
			if _, err = tx.Exec(ctx, `UPDATE webhook_endpoints SET delivered_sequence=$2 WHERE id=$1 AND delivered_sequence<$2`, e.id, maxSeq); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func (s *Server) dispatchWebhooks(ctx context.Context) error {
	client := s.webhookClient()
	for i := 0; i < webhookDispatchBatch; i++ {
		done, err := s.dispatchOneWebhook(ctx, client)
		if err != nil {
			return err
		}
		if done {
			return nil
		}
	}
	return nil
}

// dispatchOneWebhook claims one due delivery (SKIP LOCKED so workers run in
// parallel), POSTs it, and records success or a backed-off retry. It returns
// done=true when no due delivery remains.
func (s *Server) dispatchOneWebhook(ctx context.Context, client *http.Client) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var id, eventType, target, sealed string
	var payload []byte
	var attempts int
	err = tx.QueryRow(ctx, `SELECT d.id,d.event_type,d.payload,d.attempts,e.url,e.signing_secret
		FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id
		WHERE d.delivered_at IS NULL AND d.abandoned_at IS NULL AND d.next_attempt_at<=now() AND e.enabled
		ORDER BY d.event_sequence FOR UPDATE OF d SKIP LOCKED LIMIT 1`).Scan(&id, &eventType, &payload, &attempts, &target, &sealed)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return true, nil
		}
		return false, err
	}
	status, code := s.sendWebhook(ctx, client, target, eventType, id, sealed, payload)
	if code == "" {
		// 2xx success.
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET delivered_at=now(),attempts=attempts+1,last_status=$2,last_error_code=NULL WHERE id=$1`, id, status); err != nil {
			return false, err
		}
		return false, tx.Commit(ctx)
	}
	next := attempts + 1
	delay := time.Duration(1<<min(next, 6)) * time.Second
	var statusArg any
	if status != 0 {
		statusArg = status
	}
	if next >= webhookAttemptCeiling {
		_, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET attempts=$2,abandoned_at=now(),last_status=$3,last_error_code=$4 WHERE id=$1`, id, next, statusArg, code)
	} else {
		_, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET attempts=$2,next_attempt_at=now()+$3::interval,last_status=$4,last_error_code=$5 WHERE id=$1`, id, next, fmt.Sprintf("%f seconds", delay.Seconds()), statusArg, code)
	}
	if err != nil {
		return false, err
	}
	return false, tx.Commit(ctx)
}

// sendWebhook decrypts the endpoint secret, signs and POSTs the payload. It
// returns the HTTP status and an empty error code on 2xx success, or a
// classified error code (and status 0 for a transport failure) otherwise.
func (s *Server) sendWebhook(ctx context.Context, client *http.Client, endpoint, eventType, deliveryID, sealed string, payload []byte) (int, string) {
	secret, err := s.signer.OpenSecret("webhook_signing_secret", sealed)
	if err != nil {
		return 0, "SIGNING_FAILED"
	}
	// Belt-and-braces: re-validate the stored URL at delivery time unless the
	// test seam is active, so a later allowlist change or DNS result is honored.
	if !s.options.WebhookInsecure {
		if validateWebhookURL(ctx, endpoint, s.options.WebhookAllowlist, webhookResolve) != nil {
			return 0, "SSRF_BLOCKED"
		}
	}
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(payload))
	if err != nil {
		return 0, "TRANSPORT"
	}
	timestamp := time.Now().Unix()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ACCP-Webhook")
	req.Header.Set("X-ACCP-Event", eventType)
	req.Header.Set("X-ACCP-Delivery", deliveryID)
	req.Header.Set("X-ACCP-Timestamp", strconv.FormatInt(timestamp, 10))
	req.Header.Set("X-ACCP-Signature", signWebhook(secret, timestamp, payload))
	res, err := client.Do(req)
	if err != nil {
		if errors.Is(err, errSSRFBlocked) {
			return 0, "SSRF_BLOCKED"
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return 0, "TIMEOUT"
		}
		return 0, "TRANSPORT"
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64*1024))
	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return res.StatusCode, ""
	case res.StatusCode >= 400 && res.StatusCode < 500:
		return res.StatusCode, "HTTP_4XX"
	case res.StatusCode >= 500:
		return res.StatusCode, "HTTP_5XX"
	default:
		return res.StatusCode, "HTTP_OTHER"
	}
}

package controlplane

import (
	"context"
	"encoding/json"
	"net"
	"testing"
)

func TestRedactEventStripsNonWhitelistedFields(t *testing.T) {
	event := map[string]any{
		"specversion":     "1.0",
		"id":              "event_1",
		"type":            "io.accp.REVIEW_REQUIRED.v1",
		"source":          "urn:accp:control-plane",
		"subject":         "task_1",
		"time":            "2026-11-03T00:00:00Z",
		"datacontenttype": "application/json",
		"leaked_top":      "should not survive",
		"data": map[string]any{
			"task_id":       "task_1",
			"owner_user_id": "user_1",
			"decision":      "ACCEPT",
			"token":         "secret-token",
			"access_token":  "glpat-xxx",
			"context_body":  "private requirement text",
			"free_text":     "arbitrary note",
		},
	}
	out := redactEvent(event)
	if out["leaked_top"] != nil {
		t.Fatal("non-envelope top-level field survived redaction")
	}
	for _, keep := range []string{"specversion", "id", "type", "source", "subject", "time"} {
		if out[keep] == nil {
			t.Fatalf("envelope field %s was dropped", keep)
		}
	}
	data, ok := out["data"].(map[string]any)
	if !ok {
		t.Fatal("data object missing")
	}
	for _, keep := range []string{"task_id", "owner_user_id", "decision"} {
		if data[keep] == nil {
			t.Fatalf("whitelisted data field %s was dropped", keep)
		}
	}
	for _, leak := range []string{"token", "access_token", "context_body", "free_text"} {
		if _, present := data[leak]; present {
			t.Fatalf("sensitive data field %s leaked into payload", leak)
		}
	}
}

func TestBlockedIP(t *testing.T) {
	blocked := []string{"127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.169.254", "::1", "fe80::1", "0.0.0.0", "224.0.0.1"}
	for _, raw := range blocked {
		if !blockedIP(net.ParseIP(raw)) {
			t.Fatalf("expected %s to be blocked", raw)
		}
	}
	allowed := []string{"93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"}
	for _, raw := range allowed {
		if blockedIP(net.ParseIP(raw)) {
			t.Fatalf("expected %s to be allowed", raw)
		}
	}
}

func TestAllowlistHost(t *testing.T) {
	list := []string{"example.com", ".hooks.internal"}
	for _, host := range []string{"example.com", "EXAMPLE.COM", "a.example.com", "deep.sub.example.com", "hooks.internal", "x.hooks.internal"} {
		if !allowlistHost(host, list) {
			t.Fatalf("expected %s to match allowlist", host)
		}
	}
	for _, host := range []string{"notexample.com", "example.com.evil.com", "example.org", ""} {
		if allowlistHost(host, list) {
			t.Fatalf("did not expect %s to match allowlist", host)
		}
	}
	if allowlistHost("example.com", nil) {
		t.Fatal("empty allowlist must match nothing")
	}
}

func TestValidateWebhookURL(t *testing.T) {
	allow := []string{"example.com"}
	resolver := func(ips ...string) func(context.Context, string) ([]net.IP, error) {
		return func(context.Context, string) ([]net.IP, error) {
			out := []net.IP{}
			for _, ip := range ips {
				out = append(out, net.ParseIP(ip))
			}
			return out, nil
		}
	}
	cases := []struct {
		name    string
		url     string
		resolve func(context.Context, string) ([]net.IP, error)
		ok      bool
	}{
		{"http scheme", "http://example.com/hook", resolver("93.184.216.34"), false},
		{"userinfo", "https://user:pass@example.com/hook", resolver("93.184.216.34"), false},
		{"fragment", "https://example.com/hook#x", resolver("93.184.216.34"), false},
		{"off allowlist", "https://evil.com/hook", resolver("93.184.216.34"), false},
		{"resolves loopback", "https://example.com/hook", resolver("127.0.0.1"), false},
		{"resolves private", "https://example.com/hook", resolver("10.0.0.9"), false},
		{"resolves metadata", "https://example.com/hook", resolver("169.254.169.254"), false},
		{"mixed public+private", "https://example.com/hook", resolver("93.184.216.34", "10.0.0.9"), false},
		{"public accept", "https://hooks.example.com/hook?token=abc", resolver("93.184.216.34"), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateWebhookURL(context.Background(), tc.url, allow, tc.resolve)
			if tc.ok && err != nil {
				t.Fatalf("expected accept, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("expected rejection")
			}
		})
	}
}

func TestSignWebhookStableAndTimestampBound(t *testing.T) {
	body := []byte(`{"id":"event_1"}`)
	a := signWebhook("whsec_abc", 1762128000, body)
	b := signWebhook("whsec_abc", 1762128000, body)
	if a != b {
		t.Fatal("signature not stable for identical inputs")
	}
	if a[:7] != "sha256=" {
		t.Fatalf("unexpected signature prefix: %s", a)
	}
	if signWebhook("whsec_abc", 1762128001, body) == a {
		t.Fatal("signature must change when the timestamp changes")
	}
	if signWebhook("whsec_other", 1762128000, body) == a {
		t.Fatal("signature must change when the secret changes")
	}
}

func TestWebhookEventTypesRejectsUnknown(t *testing.T) {
	var raw []any
	_ = json.Unmarshal([]byte(`["REVIEW_REQUIRED","APPROVAL_DECIDED"]`), &raw)
	types, ok := webhookEventTypes(raw)
	if !ok || len(types) != 2 {
		t.Fatalf("expected two valid types, got %v ok=%v", types, ok)
	}
	_ = json.Unmarshal([]byte(`["REVIEW_REQUIRED","SESSION_REVOKED"]`), &raw)
	if _, ok := webhookEventTypes(raw); ok {
		t.Fatal("unknown event type must be rejected")
	}
	if _, ok := webhookEventTypes([]any{}); ok {
		t.Fatal("empty subscription must be rejected")
	}
}

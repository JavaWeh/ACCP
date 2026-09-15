package client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCredentialAudienceAndRedirectBoundary(t *testing.T) {
	for _, origin := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=x", "file:///tmp/api"} {
		if _, err := New(origin, "accp_s_test"); err == nil {
			t.Errorf("unsafe origin accepted: %s", origin)
		}
	}
	if _, err := New("https://example.com", "human-token"); err == nil {
		t.Fatal("human credential accepted by execution SDK")
	}
	leaked := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; w.Write([]byte(`{}`)) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	c, err := New(redirect.URL, "accp_s_test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.Call(context.Background(), "GET", "/events", nil, WriteOptions{}); err == nil || leaked {
		t.Fatal("redirect forwarded Session credential")
	}
}

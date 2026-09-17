package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

func TestAccessTokenMarkersAndLiveJWKSRotation(t *testing.T) {
	first, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	second, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.RWMutex
	keys := []jose.JSONWebKey{{Key: &first.PublicKey, KeyID: "first", Algorithm: "RS256", Use: "sig"}}
	var issuer string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/openid-configuration" {
			json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "jwks_uri": issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
			return
		}
		if r.URL.Path != "/keys" {
			http.NotFound(w, r)
			return
		}
		mu.RLock()
		defer mu.RUnlock()
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: keys})
	}))
	defer srv.Close()
	issuer = srv.URL
	verifier, err := NewOIDC(context.Background(), issuer, "api")
	if err != nil {
		t.Fatal(err)
	}
	sign := func(key *rsa.PrivateKey, kid, header, claim string) string {
		t.Helper()
		options := (&jose.SignerOptions{}).WithType(jose.ContentType(header))
		signer, e := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: kid}}, options)
		if e != nil {
			t.Fatal(e)
		}
		token, e := jwt.Signed(signer).Claims(jwt.Claims{Issuer: issuer, Subject: "alice", Audience: jwt.Audience{"api"}, Expiry: jwt.NewNumericDate(time.Now().Add(time.Hour))}).Claims(map[string]any{"typ": claim}).Serialize()
		if e != nil {
			t.Fatal(e)
		}
		return token
	}
	for _, tc := range []struct {
		header, claim string
		valid         bool
	}{{"JWT", "ID", false}, {"JWT", "", false}, {"at+jwt", "", true}, {"JWT", "Bearer", true}} {
		_, e := verifier.Authenticate(context.Background(), sign(first, "first", tc.header, tc.claim))
		if (e == nil) != tc.valid {
			t.Fatalf("marker header=%s claim=%s valid=%v err=%v", tc.header, tc.claim, tc.valid, e)
		}
	}
	if _, err = verifier.Authenticate(context.Background(), "opaque-value"); err == nil {
		t.Fatal("opaque token accepted")
	}
	mu.Lock()
	keys = append(keys, jose.JSONWebKey{Key: &second.PublicKey, KeyID: "second", Algorithm: "RS256", Use: "sig"})
	mu.Unlock()
	if _, err = verifier.Authenticate(context.Background(), sign(second, "second", "at+jwt", "")); err != nil {
		t.Fatalf("new kid did not refresh JWKS: %v", err)
	}
	if _, err = verifier.Authenticate(context.Background(), sign(first, "first", "JWT", "Bearer")); err != nil {
		t.Fatal("overlap key rejected", err)
	}
	mu.Lock()
	keys = keys[1:]
	mu.Unlock()
	// A fresh verifier proves the published retirement boundary. Existing JWT caches may
	// keep old keys until refresh; JWT expiration is therefore part of the IdP contract.
	fresh, err := NewOIDC(context.Background(), issuer, "api")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = fresh.Authenticate(context.Background(), sign(first, "first", "JWT", "Bearer")); err == nil {
		t.Fatal("retired key accepted by fresh verifier")
	}
}

package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

func TestOIDCVerification(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var issuer string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "jwks_uri": issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/keys":
			_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "test", Algorithm: "RS256", Use: "sig"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	issuer = server.URL
	verifier, err := NewOIDC(context.Background(), issuer, "accp-api")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: "test"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, iss, sub, aud string
		expiry              time.Time
		valid               bool
	}{
		{"valid", issuer, "alice", "accp-api", time.Now().Add(time.Hour), true},
		{"wrong audience", issuer, "alice", "web-console", time.Now().Add(time.Hour), false},
		{"wrong issuer", "https://other.example", "alice", "accp-api", time.Now().Add(time.Hour), false},
		{"expired", issuer, "alice", "accp-api", time.Now().Add(-time.Hour), false},
		{"missing subject", issuer, "", "accp-api", time.Now().Add(time.Hour), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token, err := jwt.Signed(signer).Claims(jwt.Claims{Issuer: tc.iss, Subject: tc.sub, Audience: jwt.Audience{tc.aud}, Expiry: jwt.NewNumericDate(tc.expiry)}).Serialize()
			if err != nil {
				t.Fatal(err)
			}
			identity, err := verifier.Authenticate(context.Background(), token)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, err=%v", tc.valid, err)
			}
			if tc.valid && (identity.Subject != "alice" || identity.Issuer != issuer) {
				t.Fatal("wrong identity")
			}
			if _, err = verifier.Authenticate(context.Background(), token+"tampered"); err == nil {
				t.Fatal("tampered signature accepted")
			}
		})
	}
}

package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// SessionSigner uses a dedicated API key; it never accepts an upstream OIDC token
// or produces a token for a downstream tool. Current grants live in PostgreSQL.
type SessionSigner struct{ key []byte }

func NewSessionSigner(key []byte) (*SessionSigner, error) {
	if len(key) != 32 {
		return nil, errors.New("Session key must contain exactly 32 bytes")
	}
	return &SessionSigner{key: append([]byte(nil), key...)}, nil
}

func (s *SessionSigner) Seal(purpose, payload string) string {
	mac := hmac.New(sha256.New, s.key)
	_, _ = mac.Write([]byte("accp/api/v1/" + purpose + "\x00" + payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *SessionSigner) Open(purpose, value string) (string, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 || len(value) > 4096 {
		return "", errors.New("invalid signed value")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", errors.New("invalid signed value")
	}
	expected := s.Seal(purpose, string(payload))
	if !hmac.Equal([]byte(expected), []byte(value)) {
		return "", errors.New("invalid signature")
	}
	return string(payload), nil
}

func (s *SessionSigner) Token(sessionID string) string {
	return "accp_s_" + s.Seal("session", sessionID)
}
func (s *SessionSigner) SessionID(token string) (string, error) {
	if !strings.HasPrefix(token, "accp_s_") {
		return "", errors.New("invalid Session token")
	}
	return s.Open("session", strings.TrimPrefix(token, "accp_s_"))
}

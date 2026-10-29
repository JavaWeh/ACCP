package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// SessionSigner uses a dedicated API key; it never accepts an upstream OIDC token
// or produces a token for a downstream tool. Current grants live in PostgreSQL.
type SessionSigner struct {
	key    []byte
	active string
	keys   map[string][]byte
}

func NewSessionSigner(key []byte) (*SessionSigner, error) {
	if len(key) != 32 {
		return nil, errors.New("Session key must contain exactly 32 bytes")
	}
	return &SessionSigner{key: append([]byte(nil), key...)}, nil
}

func (s *SessionSigner) Seal(purpose, payload string) string {
	if s.active != "" {
		return s.active + "." + signValue(s.keys[s.active], purpose+"\x00"+s.active, payload)
	}
	return signValue(s.key, purpose, payload)
}

func signValue(key []byte, purpose, payload string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("accp/api/v1/" + purpose + "\x00" + payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *SessionSigner) Open(purpose, value string) (string, error) {
	parts := strings.Split(value, ".")
	key := s.key
	if len(parts) == 3 {
		key = s.keys[parts[0]]
		purpose += "\x00" + parts[0]
		value = strings.Join(parts[1:], ".")
		parts = parts[1:]
	}
	if len(key) != 32 || len(parts) != 2 || len(value) > 4096 {
		return "", errors.New("invalid signed value")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", errors.New("invalid signed value")
	}
	expected := signValue(key, purpose, string(payload))
	if !hmac.Equal([]byte(expected), []byte(value)) {
		return "", errors.New("invalid signature")
	}
	return string(payload), nil
}

// Legacy accepts unversioned credentials only when explicitly supplied during migration.
func NewKeyring(active string, keys map[string][]byte, legacy []byte) (*SessionSigner, error) {
	if active == "" || len(keys) == 0 || len(keys) > 8 || len(keys[active]) != 32 || len(legacy) != 0 && len(legacy) != 32 {
		return nil, errors.New("invalid signing keyring")
	}
	s := &SessionSigner{active: active, keys: map[string][]byte{}, key: append([]byte(nil), legacy...)}
	for id, key := range keys {
		if len(id) == 0 || len(id) > 32 || len(key) != 32 {
			return nil, errors.New("invalid signing key")
		}
		for _, c := range id {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
				return nil, errors.New("invalid key identifier")
			}
		}
		s.keys[id] = append([]byte(nil), key...)
	}
	return s, nil
}

// SealSecret encrypts a confidential value (for example a per-repository
// read-only Git access token) for at-rest storage. Unlike Seal, which only
// signs a recoverable plaintext payload, SealSecret uses authenticated
// AES-256-GCM so the ciphertext never reveals the secret. The per-purpose key
// is derived from the active signing key, so credentials rotate with the
// keyring and a value sealed under one purpose cannot be opened under another.
func (s *SessionSigner) SealSecret(purpose, plaintext string) (string, error) {
	if s.active != "" {
		sealed, err := sealSecret(s.keys[s.active], "enc/"+purpose+"\x00"+s.active, plaintext)
		if err != nil {
			return "", err
		}
		return s.active + "." + sealed, nil
	}
	return sealSecret(s.key, "enc/"+purpose, plaintext)
}

func (s *SessionSigner) OpenSecret(purpose, value string) (string, error) {
	key := s.key
	if id, rest, ok := strings.Cut(value, "."); ok && s.keys != nil {
		if k, present := s.keys[id]; present {
			key = k
			purpose += "\x00" + id
			value = rest
		}
	}
	return openSecret(key, "enc/"+purpose, value)
}

func secretKey(key []byte, purpose string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("accp/api/v1/" + purpose))
	return mac.Sum(nil)
}

func sealSecret(key []byte, purpose, plaintext string) (string, error) {
	if len(key) != 32 {
		return "", errors.New("invalid encryption key")
	}
	block, err := aes.NewCipher(secretKey(key, purpose))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), []byte("accp/api/v1/"+purpose))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func openSecret(key []byte, purpose, value string) (string, error) {
	if len(key) != 32 || len(value) > 8192 {
		return "", errors.New("invalid sealed secret")
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", errors.New("invalid sealed secret")
	}
	block, err := aes.NewCipher(secretKey(key, purpose))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("invalid sealed secret")
	}
	nonce, ciphertext := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, []byte("accp/api/v1/"+purpose))
	if err != nil {
		return "", errors.New("invalid sealed secret")
	}
	return string(plaintext), nil
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

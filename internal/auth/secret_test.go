package auth

import (
	"bytes"
	"strings"
	"testing"
)

func TestSealSecretRoundTripAndConfidentiality(t *testing.T) {
	signer, err := NewSessionSigner(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	token := "glpat-ReadOnly-0123456789"
	sealed, err := signer.SealSecret("repo_access_token", token)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sealed, token) {
		t.Fatal("ciphertext leaks the plaintext token")
	}
	got, err := signer.OpenSecret("repo_access_token", sealed)
	if err != nil || got != token {
		t.Fatalf("round trip failed: %q %v", got, err)
	}
	// A different purpose must not open the ciphertext.
	if _, err = signer.OpenSecret("session", sealed); err == nil {
		t.Fatal("secret opened under the wrong purpose")
	}
	// Tampering with the ciphertext must fail the AEAD tag.
	if _, err = signer.OpenSecret("repo_access_token", sealed[:len(sealed)-1]+"A"); err == nil {
		t.Fatal("tampered ciphertext opened")
	}
}

func TestSealSecretRotatesWithKeyring(t *testing.T) {
	keys := map[string][]byte{"k2": bytes.Repeat([]byte{9}, 32)}
	signer, err := NewKeyring("k2", keys, nil)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := signer.SealSecret("repo_access_token", "secret-value")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sealed, "k2.") {
		t.Fatalf("keyring ciphertext is not key-identified: %q", sealed)
	}
	got, err := signer.OpenSecret("repo_access_token", sealed)
	if err != nil || got != "secret-value" {
		t.Fatalf("keyring round trip failed: %q %v", got, err)
	}
}

package auth

import (
	"bytes"
	"testing"
)

func TestSessionTokensHaveSeparatePurposeAndKey(t *testing.T) {
	signer, err := NewSessionSigner(bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	token := signer.Token("session_test")
	if id, err := signer.SessionID(token); err != nil || id != "session_test" {
		t.Fatal("Session round trip failed")
	}
	if _, err = signer.SessionID(token + "x"); err == nil {
		t.Fatal("tampered token accepted")
	}
	other, _ := NewSessionSigner(bytes.Repeat([]byte{2}, 32))
	if _, err = other.SessionID(token); err == nil {
		t.Fatal("wrong key accepted")
	}
	if _, err = signer.SessionID("accp_s_" + signer.Seal("cursor", "session_test")); err == nil {
		t.Fatal("cursor accepted as Session")
	}
	if _, err = NewSessionSigner(nil); err == nil {
		t.Fatal("missing key accepted")
	}
}

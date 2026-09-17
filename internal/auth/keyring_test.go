package auth

import (
	"bytes"
	"testing"
)

func TestSigningKeyRotationAndPurpose(t *testing.T) {
	a, b := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	legacy, _ := NewSessionSigner(a)
	oldToken := legacy.Token("session_old")
	first, _ := NewKeyring("a", map[string][]byte{"a": a}, nil)
	token := first.Token("session_one")
	overlap, err := NewKeyring("b", map[string][]byte{"a": a, "b": b}, a)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{oldToken, token, overlap.Token("session_new")} {
		if _, err = overlap.SessionID(value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = overlap.Open("gateway:https://example.com/mcp", token[len("accp_s_"):]); err == nil {
		t.Fatal("session became gateway credential")
	}
	final, _ := NewKeyring("b", map[string][]byte{"b": b}, nil)
	for _, value := range []string{oldToken, token} {
		if _, err = final.SessionID(value); err == nil {
			t.Fatal("retired key accepted")
		}
	}
	if _, err = NewKeyring("bad.id", map[string][]byte{"bad.id": a}, nil); err == nil {
		t.Fatal("ambiguous key ID accepted")
	}
}

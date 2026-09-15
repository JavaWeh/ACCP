package config

import (
	"strings"
	"testing"
)

func TestExecutionConfiguration(t *testing.T) {
	t.Setenv("ACCP_SESSION_KEY", strings.Repeat("ab", 32))
	t.Setenv("ACCP_PUBLIC_URL", "http://127.0.0.1:18080")
	t.Setenv("ACCP_ENV", "development")
	if _, err := LoadExecution(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ACCP_ENV", "production")
	if _, err := LoadExecution(); err == nil {
		t.Fatal("production plaintext origin accepted")
	}
	t.Setenv("ACCP_PUBLIC_URL", "https://accp.example")
	if _, err := LoadExecution(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ACCP_SESSION_KEY", "")
	if _, err := LoadExecution(); err == nil {
		t.Fatal("missing persistent key accepted")
	}
}

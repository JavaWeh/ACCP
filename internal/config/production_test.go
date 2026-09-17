package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOIDCClientMustBeSeparate(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://local")
	t.Setenv("ACCP_ENV", "production")
	t.Setenv("ACCP_AUTH_MODE", "oidc")
	t.Setenv("ACCP_OIDC_ISSUER", "https://idp.example")
	t.Setenv("ACCP_OIDC_AUDIENCE", "api")
	for _, client := range []string{"", "api"} {
		t.Setenv("ACCP_OIDC_CLIENT_ID", client)
		if _, err := Load(); err == nil {
			t.Fatal("ambiguous audience accepted")
		}
	}
}
func TestSecretFileConflictAndLoading(t *testing.T) {
	file := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(file, []byte("postgres://test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DATABASE_URL_FILE", file)
	t.Setenv("DATABASE_URL", "existing")
	if err := LoadSecretFiles(); err == nil {
		t.Fatal("conflict accepted")
	}
	t.Setenv("DATABASE_URL", "")
	if err := LoadSecretFiles(); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("DATABASE_URL") != "postgres://test" {
		t.Fatal("file was not loaded")
	}
}

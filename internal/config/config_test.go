package config

import "testing"

func TestExplicitAuthenticationConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name, env, mode, issuer, audience string
		valid                             bool
	}{
		{name: "no implicit development"},
		{name: "development blocked in production", env: "production", mode: "development"},
		{name: "development explicit", env: "development", mode: "development", valid: true},
		{name: "OIDC HTTPS required", issuer: "http://idp.example", audience: "accp-api"},
		{name: "OIDC audience required", issuer: "https://idp.example"},
		{name: "OIDC", issuer: "https://idp.example", audience: "accp-api", valid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://local")
			t.Setenv("ACCP_ENV", tc.env)
			t.Setenv("ACCP_AUTH_MODE", tc.mode)
			t.Setenv("ACCP_OIDC_ISSUER", tc.issuer)
			t.Setenv("ACCP_OIDC_AUDIENCE", tc.audience)
			_, err := Load()
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, error=%v", tc.valid, err)
			}
		})
	}
}

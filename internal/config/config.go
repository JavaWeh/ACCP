package config

import (
	"fmt"
	"net/url"
	"os"
)

type Config struct{ DatabaseURL, ListenAddress, Environment, AuthMode, Issuer, Audience string }

func Load() (Config, error) {
	c := Config{DatabaseURL: os.Getenv("DATABASE_URL"), ListenAddress: os.Getenv("ACCP_LISTEN_ADDR"), Environment: os.Getenv("ACCP_ENV"), AuthMode: os.Getenv("ACCP_AUTH_MODE"), Issuer: os.Getenv("ACCP_OIDC_ISSUER"), Audience: os.Getenv("ACCP_OIDC_AUDIENCE")}
	if c.ListenAddress == "" {
		c.ListenAddress = "127.0.0.1:8080"
	}
	if c.Environment == "" {
		c.Environment = "production"
	}
	if c.AuthMode == "" {
		c.AuthMode = "oidc"
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL is required")
	}
	if c.Environment != "production" && c.Environment != "development" {
		return c, fmt.Errorf("invalid ACCP_ENV")
	}
	switch c.AuthMode {
	case "development":
		if c.Environment != "development" {
			return c, fmt.Errorf("development authentication requires ACCP_ENV=development")
		}
	case "oidc":
		u, err := url.Parse(c.Issuer)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || c.Audience == "" {
			return c, fmt.Errorf("OIDC requires an HTTPS issuer and dedicated API audience")
		}
	default:
		return c, fmt.Errorf("invalid ACCP_AUTH_MODE")
	}
	return c, nil
}

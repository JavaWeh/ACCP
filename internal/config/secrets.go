package config

import (
	"fmt"
	"os"
	"strings"
)

// LoadSecretFiles runs before opening connections. Neither file contents nor paths appear in errors.
func LoadSecretFiles() error {
	for _, name := range []string{"DATABASE_URL", "ACCP_SESSION_KEY", "ACCP_SESSION_KEYS", "ACCP_NATS_TOKEN", "ACCP_GITHUB_TOKEN"} {
		path := os.Getenv(name + "_FILE")
		if path == "" {
			continue
		}
		if os.Getenv(name) != "" {
			return fmt.Errorf("set only %s or %s_FILE", name, name)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("cannot read %s_FILE", name)
		}
		value := strings.TrimSpace(string(data))
		if (value == "" && name != "ACCP_GITHUB_TOKEN") || len(value) > 65536 {
			return fmt.Errorf("invalid %s_FILE content", name)
		}
		if err = os.Setenv(name, value); err != nil {
			return fmt.Errorf("cannot load %s", name)
		}
	}
	return nil
}

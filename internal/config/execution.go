package config

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/JavaWeh/ACCP/internal/auth"
	"net"
	"net/url"
	"os"
	"strings"
)

type Execution struct {
	SessionKey                                    []byte
	SessionKeys                                   map[string][]byte
	ActiveKeyID                                   string
	PublicURL, NATSURL, NATSToken, EventNamespace string
}

func LoadExecution() (Execution, error) {
	c := Execution{PublicURL: strings.TrimRight(os.Getenv("ACCP_PUBLIC_URL"), "/"), NATSURL: os.Getenv("ACCP_NATS_URL"), NATSToken: os.Getenv("ACCP_NATS_TOKEN"), EventNamespace: os.Getenv("ACCP_EVENT_NAMESPACE")}
	key, err := hex.DecodeString(os.Getenv("ACCP_SESSION_KEY"))
	if os.Getenv("ACCP_SESSION_KEYS") == "" && (err != nil || len(key) != 32) {
		return c, fmt.Errorf("ACCP_SESSION_KEY must be a persistent 32-byte key encoded as 64 hex characters")
	}
	c.SessionKey = key
	if raw := os.Getenv("ACCP_SESSION_KEYS"); raw != "" {
		var ring struct {
			Active string            `json:"active"`
			Keys   map[string]string `json:"keys"`
			Legacy string            `json:"legacy,omitempty"`
		}
		if os.Getenv("ACCP_SESSION_KEY") != "" || json.Unmarshal([]byte(raw), &ring) != nil {
			return c, fmt.Errorf("invalid or conflicting signing keyring configuration")
		}
		c.SessionKeys = map[string][]byte{}
		c.ActiveKeyID = ring.Active
		for id, value := range ring.Keys {
			b, e := hex.DecodeString(value)
			if e != nil {
				return c, fmt.Errorf("invalid signing key encoding")
			}
			c.SessionKeys[id] = b
		}
		c.SessionKey, err = hex.DecodeString(ring.Legacy)
		if err != nil {
			return c, fmt.Errorf("invalid legacy key encoding")
		}
		if _, err = auth.NewKeyring(c.ActiveKeyID, c.SessionKeys, c.SessionKey); err != nil {
			return c, err
		}
	}
	u, err := url.Parse(c.PublicURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return c, fmt.Errorf("ACCP_PUBLIC_URL must be an absolute origin without credentials, path, query or fragment")
	}
	ip := net.ParseIP(u.Hostname())
	loopback := u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback && os.Getenv("ACCP_ENV") == "development") {
		return c, fmt.Errorf("ACCP_PUBLIC_URL requires HTTPS, or loopback HTTP in explicit development")
	}
	return c, nil
}

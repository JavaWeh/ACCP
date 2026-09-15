package config

import (
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

type Execution struct {
	SessionKey                                    []byte
	PublicURL, NATSURL, NATSToken, EventNamespace string
}

func LoadExecution() (Execution, error) {
	c := Execution{PublicURL: strings.TrimRight(os.Getenv("ACCP_PUBLIC_URL"), "/"), NATSURL: os.Getenv("ACCP_NATS_URL"), NATSToken: os.Getenv("ACCP_NATS_TOKEN"), EventNamespace: os.Getenv("ACCP_EVENT_NAMESPACE")}
	key, err := hex.DecodeString(os.Getenv("ACCP_SESSION_KEY"))
	if err != nil || len(key) != 32 {
		return c, fmt.Errorf("ACCP_SESSION_KEY must be a persistent 32-byte key encoded as 64 hex characters")
	}
	c.SessionKey = key
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

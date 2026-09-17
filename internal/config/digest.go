package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
)

// RuntimeDigest compares trusted API/Worker configuration without disclosing it.
func RuntimeDigest() (string, error) {
	tools := []byte{}
	if path := os.Getenv("ACCP_TOOLS_FILE"); path != "" {
		var err error
		tools, err = os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("cannot read tools configuration")
		}
	}
	h := sha256.New()
	for _, v := range []string{os.Getenv("ACCP_PUBLIC_URL"), os.Getenv("ACCP_SESSION_KEY"), os.Getenv("ACCP_SESSION_KEYS"), string(tools)} {
		h.Write([]byte(v))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

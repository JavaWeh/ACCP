// Package buildinfo identifies candidate binaries independently of runtime configuration.
package buildinfo

import (
	"encoding/json"
	"io"
	"runtime"
)

var Version = "development"
var Revision = "unknown"
var BuiltAt = "unknown"

func Write(w io.Writer) error {
	return json.NewEncoder(w).Encode(map[string]string{"version": Version, "revision": Revision, "built_at": BuiltAt, "go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "rest_api": "/api/v1", "adapter_protocol": "0.2"})
}

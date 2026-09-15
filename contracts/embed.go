// Package contracts embeds the public schemas used by the control plane.
package contracts

import "embed"

// Schemas contains only public protocol contracts; no local configuration.
//
//go:embed schemas/*.schema.json
var Schemas embed.FS

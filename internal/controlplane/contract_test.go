package controlplane

import (
	"encoding/json"
	"testing"

	"github.com/JavaWeh/ACCP/contracts"
)

func TestPublicSchemasCompileOffline(t *testing.T) {
	schemas, err := NewValidator()
	if err != nil {
		t.Fatal(err)
	}
	data, err := contracts.Schemas.ReadFile("schemas/domain.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc Object
	if err = json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if len(schemas) < 15 || doc["$id"] != "https://accp.example/schemas/v0.1/domain.schema.json" {
		t.Fatal("public schemas not loaded")
	}
	for _, body := range []Object{
		{"title": "No owner"},
		{"command": "DONE", "reason": "agent says finished"},
		{"command": "SUBMIT", "reason": "valid", "owner_user_id": "user_forged"},
	} {
		name := "TaskCommand"
		if body["title"] != nil {
			name = "CreateTask"
		}
		if schemas[name].Validate(body) == nil {
			t.Fatalf("accepted invalid %s", name)
		}
	}
}

package controlplane

import "testing"

// TestCreateCommentSchemaRejectsStatusFields is the F11 contract guard that
// makes an advisory comment incapable of driving a state transition: the
// CreateComment/EditComment schemas are additionalProperties:false with no
// status or version property, so a payload that tries to smuggle one is
// rejected at the same compiled schema server.go runs before any handler. This
// is why a comment can never change a task's status or version — the fields
// cannot reach the write path. The runtime round-trip (post a comment, re-read
// the task, assert status+version unchanged) is asserted end-to-end in
// comments_integration_test.go.
func TestCreateCommentSchemaRejectsStatusFields(t *testing.T) {
	schemas, err := NewValidator()
	if err != nil {
		t.Fatalf("compile schemas: %v", err)
	}
	cases := []struct {
		name   string
		schema string
		body   string
		valid  bool
	}{
		{"body only", "CreateComment", `{"body":"Please add a test."}`, true},
		{"body with mentions", "CreateComment", `{"body":"ping","mentions":["user_bob"]}`, true},
		{"body with reason", "CreateComment", `{"body":"note","reason":"discuss"}`, true},
		{"empty body rejected", "CreateComment", `{"body":""}`, false},
		{"missing body rejected", "CreateComment", `{"mentions":["user_bob"]}`, false},
		// A status or version field must be rejected — this is the core F11 rule.
		{"status field rejected", "CreateComment", `{"body":"x","status":"READY"}`, false},
		{"version field rejected", "CreateComment", `{"body":"x","version":2}`, false},
		{"owner field rejected", "CreateComment", `{"body":"x","owner_user_id":"user_bob"}`, false},
		{"command field rejected", "CreateComment", `{"body":"x","command":"SUBMIT"}`, false},
		{"duplicate mentions rejected", "CreateComment", `{"body":"x","mentions":["user_bob","user_bob"]}`, false},
		{"malformed mention id rejected", "CreateComment", `{"body":"x","mentions":["1bad id"]}`, false},
		// Edit accepts only a new body; nothing else, especially no status.
		{"edit body only", "EditComment", `{"body":"revised"}`, true},
		{"edit status rejected", "EditComment", `{"body":"x","status":"DONE"}`, false},
		{"edit empty body rejected", "EditComment", `{"body":""}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			schema, ok := schemas[c.schema]
			if !ok {
				t.Fatalf("schema %q not registered", c.schema)
			}
			err := schema.Validate(decodeBody(t, c.body))
			if c.valid && err != nil {
				t.Fatalf("expected %s to accept %s: %v", c.schema, c.body, err)
			}
			if !c.valid && err == nil {
				t.Fatalf("expected %s to reject %s", c.schema, c.body)
			}
		})
	}
}

// TestMentionIDsDeduplicatesAndRejectsNonStrings pins the pure mention parser:
// an absent field is valid with no ids, strings are deduplicated in first-seen
// order, and a non-string element is rejected so a malformed mentions array
// never reaches the membership check.
func TestMentionIDsDeduplicatesAndRejectsNonStrings(t *testing.T) {
	// Absent mentions must yield a non-nil empty slice so createComment binds a
	// SQL '{}' and not NULL against task_comments.mentions (NOT NULL DEFAULT '{}').
	if ids, ok := mentionIDs(nil); !ok || ids == nil || len(ids) != 0 {
		t.Fatalf("absent mentions: got %v ok=%v", ids, ok)
	}
	ids, ok := mentionIDs([]any{"user_a", "user_b", "user_a"})
	if !ok {
		t.Fatal("well-formed mentions should be ok")
	}
	if len(ids) != 2 || ids[0] != "user_a" || ids[1] != "user_b" {
		t.Fatalf("dedup/order wrong: %v", ids)
	}
	if _, ok := mentionIDs([]any{"user_a", 7}); ok {
		t.Fatal("a non-string mention element must be rejected")
	}
}

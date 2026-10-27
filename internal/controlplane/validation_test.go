package controlplane

import (
	"encoding/json"
	"testing"
)

// decodeBody mirrors how the server decodes a request body before schema
// validation: JSON into generic Go values so numbers are float64, booleans are
// bool, and arrays are []any. Building the maps by hand would not exercise the
// same shapes the compiled schema sees at runtime.
func decodeBody(t *testing.T, raw string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("invalid test fixture JSON %q: %v", raw, err)
	}
	return v
}

// TestRequestSchemasGuardRecentSurfaces locks the request-body contracts for
// the surfaces added or changed in this batch — organization HUMAN changes
// (grant/revoke org ADMIN vs. account activate), Git context sync (US-5), and
// project member/repository registration — without a database. These are the
// same compiled schemas server.go runs for every write, so a drift in the
// contract corpus fails here before it reaches an integration environment.
func TestRequestSchemasGuardRecentSurfaces(t *testing.T) {
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
		// HumanChange is a oneOf: exactly one of account activate/deactivate or
		// org-ADMIN grant/revoke, each with a reason. Supplying both fields or
		// neither must fail the oneOf, which is what keeps the two org journals
		// from being conflated.
		{"human change active only", "ManagementHumanChange", `{"active":false,"reason":"offboarding"}`, true},
		{"human change org admin only", "ManagementHumanChange", `{"is_org_admin":true,"reason":"promote lead"}`, true},
		{"human change both fields rejected", "ManagementHumanChange", `{"active":true,"is_org_admin":true,"reason":"mix"}`, false},
		{"human change missing reason", "ManagementHumanChange", `{"active":false}`, false},
		{"human change empty reason", "ManagementHumanChange", `{"is_org_admin":false,"reason":""}`, false},
		{"human change unknown field", "ManagementHumanChange", `{"active":false,"reason":"x","role":"ADMIN"}`, false},
		{"human change empty object", "ManagementHumanChange", `{}`, false},

		// SyncGitContext must pin an immutable 40-hex commit and carry a change
		// summary; a moving ref or extra property is rejected at the contract.
		{"git sync valid", "SyncGitContext", `{"source_revision":"06d0528b6ed5754a0835c9eb39849a248a90ceeb","change_summary":"import spec"}`, true},
		{"git sync short sha", "SyncGitContext", `{"source_revision":"06d0528","change_summary":"import spec"}`, false},
		{"git sync branch ref", "SyncGitContext", `{"source_revision":"main","change_summary":"import spec"}`, false},
		{"git sync missing summary", "SyncGitContext", `{"source_revision":"06d0528b6ed5754a0835c9eb39849a248a90ceeb"}`, false},
		{"git sync extra field", "SyncGitContext", `{"source_revision":"06d0528b6ed5754a0835c9eb39849a248a90ceeb","change_summary":"x","path":"README.md"}`, false},

		// AddMember / RegisterRepository guard project day-2 operations.
		{"add member valid", "ManagementAddMember", `{"user_id":"alice","roles":["ADMIN"],"reason":"join"}`, true},
		{"add member empty roles", "ManagementAddMember", `{"user_id":"alice","roles":[],"reason":"join"}`, false},
		{"add member duplicate roles", "ManagementAddMember", `{"user_id":"alice","roles":["ADMIN","ADMIN"],"reason":"join"}`, false},
		{"add member unknown role", "ManagementAddMember", `{"user_id":"alice","roles":["OWNER"],"reason":"join"}`, false},
		{"add member bad user id", "ManagementAddMember", `{"user_id":"1alice","roles":["MEMBER"],"reason":"join"}`, false},
		{"register repo valid", "ManagementRegisterRepository", `{"url":"https://github.com/example/repo","default_branch":"main","reason":"src"}`, true},
		{"register repo missing branch", "ManagementRegisterRepository", `{"url":"https://github.com/example/repo","reason":"src"}`, false},
		{"register repo missing reason", "ManagementRegisterRepository", `{"url":"https://github.com/example/repo","default_branch":"main"}`, false},
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

// TestMembershipDocActiveIsConjunction documents the rule that a member counts
// as active only when both their project membership and their organization
// account are active — the invariant the org account-level deactivate in this
// batch relies on so revoking an account hides the member everywhere.
func TestMembershipDocActiveIsConjunction(t *testing.T) {
	cases := []struct {
		membership, account, wantActive bool
	}{
		{true, true, true},
		{true, false, false},
		{false, true, false},
		{false, false, false},
	}
	for _, c := range cases {
		doc := membershipDoc("u", "org", "proj", "Name", []string{"MEMBER"}, c.membership, c.account, 3)
		if doc["membership_active"] != c.membership || doc["account_active"] != c.account {
			t.Fatalf("membershipDoc dropped source flags: %+v", doc)
		}
		if doc["active"] != c.wantActive {
			t.Fatalf("active for membership=%v account=%v: got %v want %v", c.membership, c.account, doc["active"], c.wantActive)
		}
	}
}

// TestHasRoleTreatsAdminAsSuperset pins the authorization helper: ADMIN
// satisfies any role check, and otherwise the exact role must be present.
func TestHasRoleTreatsAdminAsSuperset(t *testing.T) {
	cases := []struct {
		roles []string
		role  string
		want  bool
	}{
		{[]string{"ADMIN"}, "REVIEWER", true},
		{[]string{"ADMIN"}, "VIEWER", true},
		{[]string{"MEMBER"}, "MEMBER", true},
		{[]string{"MEMBER"}, "REVIEWER", false},
		{[]string{"VIEWER"}, "ADMIN", false},
		{nil, "VIEWER", false},
	}
	for _, c := range cases {
		if got := hasRole(c.roles, c.role); got != c.want {
			t.Fatalf("hasRole(%v,%q)=%v want %v", c.roles, c.role, got, c.want)
		}
	}
}

// TestTextValueAndNumberAreTypeSafe guards the JSON accessors used throughout
// the request handlers: a wrong or missing type yields the zero value instead
// of panicking, which is what lets handlers read optional document fields.
func TestTextValueAndNumberAreTypeSafe(t *testing.T) {
	obj := Object{"name": "spec", "count": float64(7), "flag": true}
	if textValue(obj, "name") != "spec" {
		t.Fatal("textValue did not return string value")
	}
	if textValue(obj, "missing") != "" || textValue(obj, "count") != "" {
		t.Fatal("textValue should return empty for missing or non-string")
	}
	if number(obj, "count") != 7 {
		t.Fatal("number did not read float64")
	}
	if number(obj, "missing") != 0 || number(obj, "name") != 0 {
		t.Fatal("number should return 0 for missing or non-number")
	}
}

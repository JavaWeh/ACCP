//go:build integration

package controlplane

import (
	"context"
	"testing"
	"time"
)

func TestIdempotencyReplayedHeader(t *testing.T) {
	f := setupExecution(t)
	body := Object{"project_id": "project_demo", "agent_id": f.agent, "scopes": []string{"tasks:read"}, "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}
	first := f.call("bob", "POST", "/agent-sessions", "session-replay-header", "", body)
	f.expect(first, 201, "M2SessionGrant")
	if _, present := first.Header()["Idempotency-Replayed"]; present {
		t.Fatal("first response must not include Idempotency-Replayed")
	}
	var before, after int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM idempotency_records`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	replay := f.call("bob", "POST", "/agent-sessions", "session-replay-header", "", body)
	f.expect(replay, 201, "M2SessionGrant")
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM idempotency_records`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("replay changed idempotency record count from %d to %d", before, after)
	}
	if replay.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatal("replayed response must include Idempotency-Replayed: true")
	}
	if replay.Body.String() != first.Body.String() || replay.Header().Get("ETag") != first.Header().Get("ETag") {
		t.Fatal("replayed response differs from first response")
	}
	body["scopes"] = []string{"tasks:read", "context:read"}
	conflict := f.call("bob", "POST", "/agent-sessions", "session-replay-header", "", body)
	problem := f.expect(conflict, 409, "")
	if problem["code"] != "IDEMPOTENCY_CONFLICT" {
		t.Fatalf("conflict code = %v, want IDEMPOTENCY_CONFLICT", problem["code"])
	}
	if _, present := conflict.Header()["Idempotency-Replayed"]; present {
		t.Fatal("conflict response must not include Idempotency-Replayed")
	}
}

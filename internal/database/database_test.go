package database

import (
	"context"
	"testing"
)

func TestExplicitDatabaseURLRequired(t *testing.T) {
	pool, err := Open(context.Background(), "")
	if err == nil || pool != nil {
		t.Fatal("missing DATABASE_URL must fail before opening a connection")
	}
}

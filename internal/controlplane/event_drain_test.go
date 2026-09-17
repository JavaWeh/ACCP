//go:build integration

package controlplane

import (
	"context"
	"github.com/JavaWeh/ACCP/internal/eventbus"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"os"
	"testing"
	"time"
)

func TestEventDrainCountDeadlineAndReplay(t *testing.T) {
	f := setupExecution(t)
	_, v := f.candidate("bob")
	for i := 0; i < 12; i++ {
		task := f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", newID("key"), "", taskBody(textValue(v, "id"))), 201, "Task")
		f.expect(f.call("bob", "POST", "/tasks/"+textValue(task, "id")+"/changes", newID("key"), `"1"`, Object{"title": "Changed", "objective": "Drain throughput", "acceptance_criteria": []string{"Visible once"}, "reason": "Batch validation"}), 200, "Task")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	namespace := newID("drain")
	address := os.Getenv("ACCP_TEST_NATS_URL")
	w, err := eventbus.New(ctx, f.pool, address, "", namespace, f.server.schemas["M2Event"].Validate)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	nc, err := nats.Connect(address)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	js, _ := jetstream.New(nc)
	defer js.DeleteStream(context.Background(), namespace)
	if err = w.Drain(ctx, 4); err != nil {
		t.Fatal(err)
	}
	var count int
	f.pool.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE delivered_at IS NOT NULL`).Scan(&count)
	if count != 4 {
		t.Fatalf("count bound failed: %d", count)
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if w.Drain(canceled, 4) == nil {
		t.Fatal("canceled drain accepted")
	}
	if w.Drain(ctx, 65) == nil {
		t.Fatal("unbounded count accepted")
	}
	for i := 0; i < 5; i++ {
		if err = w.Drain(ctx, 64); err != nil {
			t.Fatal(err)
		}
		f.pool.QueryRow(ctx, `SELECT count(*) FROM event_feed`).Scan(&count)
		if count == 12 {
			break
		}
	}
	if count != 12 {
		t.Fatalf("missing delivered events: %d", count)
	}
	var id string
	f.pool.QueryRow(ctx, `SELECT id FROM outbox_events LIMIT 1`).Scan(&id)
	f.expect(f.call("alice", "POST", "/projects/project_demo/events/"+id+"/replay", newID("key"), "", Object{"reason": "Authorized replay"}), 202, "")
	if err = w.Drain(ctx, 64); err != nil {
		t.Fatal(err)
	}
	f.pool.QueryRow(ctx, `SELECT count(*) FROM event_feed`).Scan(&count)
	if count != 12 {
		t.Fatal("replay duplicated materialized event")
	}
}

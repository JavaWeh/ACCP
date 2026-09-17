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

func TestCanceledEventDeliveryReturnsConsumerSlot(t *testing.T) {
	f := setupExecution(t)
	_, v := f.candidate("bob")
	task := f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", newID("key"), "", taskBody(textValue(v, "id"))), 201, "Task")
	f.expect(f.call("bob", "POST", "/tasks/"+textValue(task, "id")+"/changes", newID("key"), `"1"`, Object{"title": "Changed", "objective": "Canceled delivery", "acceptance_criteria": []string{"Fast redelivery"}, "reason": "Deadline regression"}), 200, "Task")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	namespace := newID("cancel")
	address := os.Getenv("ACCP_TEST_NATS_URL")
	worker, err := eventbus.New(ctx, f.pool, address, "", namespace, f.server.schemas["M2Event"].Validate)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	nc, err := nats.Connect(address)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	js, _ := jetstream.New(nc)
	defer js.DeleteStream(context.Background(), namespace)
	if err = worker.RelayOne(ctx); err != nil {
		t.Fatal(err)
	}
	expired, stop := context.WithCancel(ctx)
	stop()
	if worker.ConsumeOne(expired) == nil {
		t.Fatal("expired consumer succeeded")
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("canceled message held consumer slot")
		case <-ticker.C:
		}
		if err = worker.Drain(ctx, 64); err != nil {
			t.Fatal(err)
		}
		var count int
		if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM event_feed`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 1 {
			break
		}
	}
}

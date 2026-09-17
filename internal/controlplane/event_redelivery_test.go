//go:build integration

package controlplane

import (
	"context"
	"errors"
	"github.com/JavaWeh/ACCP/internal/eventbus"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestEventDrainRetriesPendingAcknowledgement(t *testing.T) {
	f := setupExecution(t)
	_, v := f.candidate("bob")
	task := f.expect(f.call("bob", "POST", "/projects/project_demo/tasks", newID("key"), "", taskBody(textValue(v, "id"))), 201, "Task")
	f.expect(f.call("bob", "POST", "/tasks/"+textValue(task, "id")+"/changes", newID("key"), `"1"`, Object{"title": "Changed", "objective": "NAK recovery", "acceptance_criteria": []string{"One event"}, "reason": "Redelivery test"}), 200, "Task")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var fail atomic.Bool
	fail.Store(true)
	namespace := newID("nak")
	w, err := eventbus.New(ctx, f.pool, os.Getenv("ACCP_TEST_NATS_URL"), "", namespace, func(value any) error {
		if fail.Load() {
			return errors.New("temporary validation failure")
		}
		return f.server.schemas["M2Event"].Validate(value)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	nc, err := nats.Connect(os.Getenv("ACCP_TEST_NATS_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	js, _ := jetstream.New(nc)
	defer js.DeleteStream(context.Background(), namespace)
	if err = w.Drain(ctx, 64); err == nil {
		t.Fatal("expected injected consumer failure")
	}
	stream, _ := js.Stream(ctx, namespace)
	consumer, _ := stream.Consumer(ctx, "event_feed")
	info, err := consumer.Info(ctx)
	if err != nil || info.NumPending != 0 || info.NumAckPending != 1 {
		t.Fatalf("missing pending acknowledgement: %+v %v", info, err)
	}
	fail.Store(false)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("delayed NAK was never retried")
		case <-ticker.C:
		}
		if err = w.Drain(ctx, 64); err != nil {
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

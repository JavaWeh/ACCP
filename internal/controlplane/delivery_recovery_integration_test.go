//go:build integration

package controlplane

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/JavaWeh/ACCP/internal/eventbus"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

func TestM2DeliveryFailureAndReplay(t *testing.T) {
	f := setupExecution(t)
	c, v := f.candidate("bob")
	f.expect(f.call("bob", "POST", "/contexts/"+textValue(c, "id")+"/versions/"+textValue(v, "id")+"/publish", newID("key"), `"1"`, nil), 200, "ContextVersion")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	namespace := newID("recovery")
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
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	defer js.DeleteStream(context.Background(), namespace)
	var id string
	var raw []byte
	if err = f.pool.QueryRow(ctx, `SELECT id,event FROM outbox_events LIMIT 1`).Scan(&id, &raw); err != nil {
		t.Fatal(err)
	}
	var event Object
	if err = json.Unmarshal(raw, &event); err != nil {
		t.Fatal(err)
	}
	event["data"].(map[string]any)["aggregate_version"] = float64(999)
	forged, _ := json.Marshal(event)
	if _, err = js.Publish(ctx, "accp."+namespace+".events", forged); err != nil {
		t.Fatal(err)
	}
	failed := false
	for ctx.Err() == nil {
		_ = w.ConsumeOne(ctx)
		if err = f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM event_failures WHERE event_id=$1 AND attempts>=5 AND resolved_at IS NULL)`, id).Scan(&failed); err != nil {
			t.Fatal(err)
		}
		if failed {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !failed {
		t.Fatal("failed delivery was not durably recorded")
	}
	var count int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM event_feed`).Scan(&count); err != nil || count != 0 {
		t.Fatal("untrusted event reached feed", err)
	}
	f.expect(f.call("alice", "POST", "/projects/project_demo/events/"+id+"/replay", newID("key"), "", Object{"reason": "Replay committed intent after invalid transport message"}), 202, "")
	if err = w.RelayOne(ctx); err != nil {
		t.Fatal(err)
	}
	for ctx.Err() == nil {
		if err = w.ConsumeOne(ctx); err != nil {
			t.Fatal(err)
		}
		if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM event_feed WHERE event_id=$1`, id).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 1 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	var resolved bool
	if err = f.pool.QueryRow(ctx, `SELECT resolved_at IS NOT NULL FROM event_failures WHERE event_id=$1`, id).Scan(&resolved); err != nil || !resolved || count != 1 {
		t.Fatal("replay did not recover failed delivery", err)
	}
}

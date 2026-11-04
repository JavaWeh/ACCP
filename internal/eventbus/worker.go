// Package eventbus relays committed intents and materializes a deduplicated event feed.
package eventbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

type Worker struct {
	pool                *pgxpool.Pool
	nc                  *nats.Conn
	js                  jetstream.JetStream
	consumer            jetstream.Consumer
	validate            func(any) error
	subject, consumerID string
}

func New(ctx context.Context, pool *pgxpool.Pool, url, token, namespace string, validate func(any) error) (*Worker, error) {
	if namespace == "" {
		namespace = "ACCP"
	}
	// Namespace is operator configuration, not an Agent-provided NATS subject.
	for _, r := range namespace {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') {
			return nil, errors.New("invalid event namespace")
		}
	}
	if url == "" {
		return nil, errors.New("ACCP_NATS_URL is required")
	}
	nc, err := nats.Connect(url, nats.Token(token), nats.Timeout(5*time.Second), nats.MaxReconnects(-1))
	if err != nil {
		return nil, errors.New("NATS connection failed")
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, err
	}
	subject := "accp." + namespace + ".events"
	stream, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{Name: namespace, Subjects: []string{subject}, Storage: jetstream.FileStorage, MaxAge: 7 * 24 * time.Hour, MaxBytes: 256 * 1024 * 1024, Discard: jetstream.DiscardNew, Duplicates: 2 * time.Minute})
	if err != nil {
		nc.Close()
		return nil, errors.New("NATS stream configuration failed")
	}
	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{Durable: "event_feed", AckPolicy: jetstream.AckExplicitPolicy, AckWait: 30 * time.Second, MaxAckPending: 1})
	if err != nil {
		nc.Close()
		return nil, errors.New("NATS consumer configuration failed")
	}
	return &Worker{pool: pool, nc: nc, js: js, consumer: consumer, validate: validate, subject: subject, consumerID: namespace + "/event_feed"}, nil
}
func (w *Worker) Close() { w.nc.Close() }

// Per-tick drain bounds. Processing one outbox row (and one feed message) per
// 250ms tick caps delivery at ~4/s, so under W0 backlog a specific event waits
// seconds behind the queue — the measured Event-visibility P95 regression.
// Draining empties the ready work each tick instead; the advisory locks still
// serialize relay (1094927185) and feed allocation (1094927186), and the bounds
// keep a single tick from starving the health write or ctx cancellation.
const (
	relayBatchMax   = 256
	consumeBatchMax = 256
)

func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(250 * time.Millisecond)
	lastHealth := time.Time{}
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		healthy := w.nc.IsConnected()
		step, cancel := context.WithTimeout(ctx, 5*time.Second)
		if err := w.relayBatch(step); err != nil && ctx.Err() == nil {
			healthy = false
			slog.Warn("event relay deferred", "error_type", fmt.Sprintf("%T", err))
		}
		cancel()
		step, cancel = context.WithTimeout(ctx, 5*time.Second)
		if err := w.consumeBatch(step); err != nil && ctx.Err() == nil {
			healthy = false
			slog.Warn("event consume deferred", "error_type", fmt.Sprintf("%T", err))
		}
		cancel()
		if healthy && time.Since(lastHealth) > 5*time.Second {
			healthCtx, done := context.WithTimeout(ctx, 2*time.Second)
			_, err := w.pool.Exec(healthCtx, `INSERT INTO worker_health(id,event_at) VALUES('default',now()) ON CONFLICT(id) DO UPDATE SET event_at=now()`)
			done()
			if err == nil {
				lastHealth = time.Now()
			}
		}
	}
}

// relayBatch publishes due outbox rows until none remain, a row defers (backoff
// or not yet due), or the per-tick budget/deadline is reached. Each row keeps
// its own transaction and advisory lock, so semantics match a single RelayOne.
func (w *Worker) relayBatch(ctx context.Context) error {
	for n := 0; n < relayBatchMax && ctx.Err() == nil; n++ {
		progressed, err := w.relayOne(ctx)
		if err != nil {
			return err
		}
		if !progressed {
			return nil
		}
	}
	return nil
}

// consumeBatch persists ready feed messages until the stream is drained or the
// per-tick budget/deadline is reached. It fetches one unacked message at a time,
// so the consumer's MaxAckPending:1 contract is unchanged.
func (w *Worker) consumeBatch(ctx context.Context) error {
	for n := 0; n < consumeBatchMax && ctx.Err() == nil; n++ {
		progressed, err := w.consumeOne(ctx)
		if err != nil {
			return err
		}
		if !progressed {
			return nil
		}
	}
	return nil
}

// RelayOne publishes a single due outbox row. Retained for integration tests;
// Run drains via relayBatch.
func (w *Worker) RelayOne(ctx context.Context) error {
	_, err := w.relayOne(ctx)
	return err
}

// relayOne returns progressed=true only when a row was delivered and committed.
// A deferred head (empty queue, not-due, backoff, or lost lock) returns false so
// the batch stops without flagging the worker unhealthy.
func (w *Worker) relayOne(ctx context.Context) (bool, error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(1094927185)`).Scan(&locked); err != nil || !locked {
		return false, err
	}
	var id string
	var data []byte
	var replay, attempt int
	var due bool
	err = tx.QueryRow(ctx, `SELECT id,event,replay_version,attempts,next_attempt_at<=now() FROM outbox_events WHERE delivered_at IS NULL ORDER BY sequence LIMIT 1 FOR UPDATE`).Scan(&id, &data, &replay, &attempt, &due)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil || !due {
		return false, err
	}
	_, err = w.js.Publish(ctx, w.subject, data, jetstream.WithMsgID(fmt.Sprintf("%s:%d", id, replay)))
	if err != nil {
		delay := time.Duration(1<<min(attempt, 6)) * time.Second
		// A publish timeout may mean NATS accepted it. Reuse the same message ID on retry.
		recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, e := tx.Exec(recordCtx, `UPDATE outbox_events SET attempts=attempts+1,last_error_code='PUBLISH_UNCONFIRMED',next_attempt_at=now()+$2::interval WHERE id=$1`, id, fmt.Sprintf("%f seconds", delay.Seconds())); e != nil {
			return false, e
		}
		// Head row is now backed off; stop draining this tick without flagging unhealthy.
		return false, tx.Commit(recordCtx)
	}
	_, err = tx.Exec(ctx, `UPDATE outbox_events SET delivered_at=now(),attempts=attempts+1,last_error_code=NULL WHERE id=$1`, id)
	if err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// ConsumeOne persists a single delivered message. Retained for integration
// tests; Run drains via consumeBatch.
func (w *Worker) ConsumeOne(ctx context.Context) error {
	_, err := w.consumeOne(ctx)
	return err
}

// consumeOne returns progressed=true when a message was persisted-and-acked or
// durably recorded-and-terminated. An empty fetch returns false so the batch
// stops; a Nak returns the error so Run can defer and retry next tick.
func (w *Worker) consumeOne(ctx context.Context) (bool, error) {
	batch, err := w.consumer.FetchNoWait(1)
	if err != nil {
		return false, err
	}
	processed := false
	for msg := range batch.Messages() {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		step, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = w.persist(step, msg.Data())
		cancel()
		if err == nil {
			if err = msg.DoubleAck(ctx); err != nil {
				return false, err
			}
			processed = true
			continue
		}
		metadata, e := msg.Metadata()
		if e != nil {
			return false, e
		}
		if metadata.NumDelivered >= 5 {
			// Failure must be durable before terminating delivery. A DB outage never discards intent.
			step, cancel = context.WithTimeout(ctx, 5*time.Second)
			e = w.recordFailure(step, msg.Data(), metadata.NumDelivered)
			cancel()
			if e == nil {
				_ = msg.Term()
				processed = true
				continue
			}
		}
		_ = msg.NakWithDelay(time.Second)
		return false, err
	}
	return processed, batch.Error()
}
func (w *Worker) persist(ctx context.Context, data []byte) error {
	var event map[string]any
	if json.Unmarshal(data, &event) != nil || w.validate(event) != nil {
		return errors.New("invalid event contract")
	}
	id, _ := event["id"].(string)
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var canonical []byte
	var project, org string
	err = tx.QueryRow(ctx, `SELECT event,project_id,organization_id FROM outbox_events WHERE id=$1`, id).Scan(&canonical, &project, &org)
	if err != nil {
		return err
	}
	var expected map[string]any
	_ = json.Unmarshal(canonical, &expected)
	a, _ := json.Marshal(expected)
	b, _ := json.Marshal(event)
	if string(a) != string(b) {
		return errors.New("event differs from committed intent")
	}
	// Serializes feed allocation across Worker processes, including a delivery after ACK timeout.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(1094927186)`); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO event_inbox(consumer_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, w.consumerID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		_, err = tx.Exec(ctx, `INSERT INTO event_feed(event_id,project_id,organization_id,event) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING`, id, project, org, canonical)
		if err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE event_failures SET resolved_at=now() WHERE event_id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (w *Worker) recordFailure(ctx context.Context, data []byte, attempt uint64) error {
	var event map[string]any
	_ = json.Unmarshal(data, &event)
	id, _ := event["id"].(string)
	if id == "" || len(id) > 128 {
		id = "invalid_message"
	}
	_, err := w.pool.Exec(ctx, `INSERT INTO event_failures(event_id,error_code,attempts) VALUES($1,'CONSUME_REJECTED',$2) ON CONFLICT(event_id) DO UPDATE SET attempts=EXCLUDED.attempts,failed_at=now(),resolved_at=NULL`, id, int64(attempt))
	return err
}

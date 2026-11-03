-- F5 (US-22) outbound webhook notifications. Each project may register several
-- signed HTTPS endpoints (project ADMIN only). The signing secret is stored as
-- authenticated AES-256-GCM ciphertext (SessionSigner.SealSecret with the
-- "webhook_signing_secret" purpose), out of any document, so it is never echoed
-- by a list/get handler and only ever decrypted server-side at delivery time.
-- Fan-out reads the existing deduplicated event_feed, so internal/eventbus is
-- untouched; deliveries mirror the outbox_events backoff columns.
CREATE TABLE webhook_endpoints (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  url text NOT NULL,                       -- https only; host on the operator allowlist; no userinfo/fragment
  event_types text[] NOT NULL,             -- user-facing subscription names (REVIEW_REQUIRED/APPROVAL_DECIDED/TASK_BLOCKED)
  signing_secret text NOT NULL,            -- AES-256-GCM ciphertext (authenticated); never plaintext
  enabled boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  -- Fan-out high-water mark: every event_feed.sequence up to here has been
  -- enqueued for this endpoint. Set to the current feed cursor at creation so a
  -- new endpoint only ever receives future events (no historical backfill).
  delivered_sequence bigint NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  CHECK (array_length(event_types, 1) BETWEEN 1 AND 20)
);
CREATE INDEX webhook_endpoints_project ON webhook_endpoints(organization_id, project_id);

-- One row per (endpoint, event) delivery intent, mirroring the outbox_events
-- backoff columns. payload is the already-redacted field-whitelist projection
-- (never a token or private Context body).
CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,
  endpoint_id text NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  event_id text NOT NULL REFERENCES outbox_events(id),
  event_sequence bigint NOT NULL,          -- from event_feed.sequence; ordering and high-water
  event_type text NOT NULL,                -- user-facing subscription name carried in the signed header
  payload jsonb NOT NULL,                  -- redacted field-whitelist projection
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  abandoned_at timestamptz,                -- set after the attempt ceiling; distinguishes "retrying" from "given up"
  last_status integer,                     -- last HTTP status code
  last_error_code text,                    -- SSRF_BLOCKED / TIMEOUT / HTTP_4XX / HTTP_5XX / TRANSPORT ...
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)           -- fan-out idempotency: a repeated scan never re-enqueues
);
-- Cheap due-scan: only undelivered, not-abandoned rows ordered by next_attempt_at.
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE delivered_at IS NULL AND abandoned_at IS NULL;

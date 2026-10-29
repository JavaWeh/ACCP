-- F3 in-app notifications. Notifications are a per-user projection of the
-- project event feed (never a new source of truth): emitEvent writes them in
-- the same transaction as the business change and the outbox event, so a
-- recipient's unread badge can never disagree with the facts it summarizes.
-- Read state is per user and durable (survives refresh). Retention matches the
-- event feed (seven days) and is enforced at read time by occurred_at, so no
-- separate reaper is required.
CREATE TABLE notifications (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('TASK_ASSIGNED','REVIEW_REQUIRED','APPROVAL_PENDING','TASK_BLOCKED','COMMENT_MENTION')),
  subject text NOT NULL,
  title text NOT NULL,
  deep_link text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  -- A notification can only target a real membership (active or not); the
  -- projection inserts only for currently-active members, and the row then
  -- survives a later deactivation as an immutable record of what happened.
  FOREIGN KEY (project_id, organization_id, user_id) REFERENCES memberships(project_id, organization_id, user_id)
);
-- Newest-first keyset pagination for one recipient (occurred_at, id desc).
CREATE INDEX notifications_user_recent ON notifications(organization_id, user_id, occurred_at DESC, id DESC);
-- Cheap unread-count for the badge summary.
CREATE INDEX notifications_user_unread ON notifications(organization_id, user_id) WHERE read_at IS NULL;

-- F11 advisory task comments. A comment is a human-to-human discussion note on
-- a task; it is NEVER a state-transition channel. This table has no foreign key
-- to task status/version and no trigger, and every comment handler only ever
-- writes this table (and the notifications projection) — so nothing here can
-- move a task, approval, Run or owner. @mentions are stored as member ids and
-- fan out to the F3 notification ledger via the existing projection, never by
-- changing the task. Edits set `edited`; deletes are soft (tombstone, body
-- cleared) so the thread stays intact and hard deletes are not offered.
CREATE TABLE task_comments (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  task_id text NOT NULL,
  author_user_id text NOT NULL,
  body text NOT NULL CHECK (octet_length(body) <= 8192),
  mentions text[] NOT NULL DEFAULT '{}',
  edited boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, project_id, organization_id) REFERENCES tasks(id, project_id, organization_id),
  -- A comment can only be authored by a real membership; the author must be an
  -- active member at write time, and the row then survives a later deactivation.
  FOREIGN KEY (project_id, organization_id, author_user_id) REFERENCES memberships(project_id, organization_id, user_id)
);
-- Chronological (oldest-first) keyset pagination for one task's thread (O-W14).
CREATE INDEX task_comments_thread ON task_comments(task_id, created_at, id);

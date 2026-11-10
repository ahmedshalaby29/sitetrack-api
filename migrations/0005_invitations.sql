-- Migration 0005: invitations schema

CREATE TABLE IF NOT EXISTS invitations (
  id                  BIGSERIAL   PRIMARY KEY,
  project_id          BIGINT      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id             BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by_user_id  BIGINT      NOT NULL REFERENCES users(id),
  status              TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  is_read             BOOLEAN     NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Decision 10: Duplicate pending invite is blocked by a partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_unique
ON invitations (project_id, user_id)
WHERE status = 'pending';

-- Fast lookup for user notifications newest first (Decision 9, Screen 3)
CREATE INDEX IF NOT EXISTS idx_invitations_user_notifications
ON invitations (user_id, created_at DESC);

-- Fast unread notifications count query for /me and X-Unread-Notifications header
CREATE INDEX IF NOT EXISTS idx_invitations_user_unread
ON invitations (user_id)
WHERE NOT is_read;

-- Project-scoped invitations index
CREATE INDEX IF NOT EXISTS idx_invitations_project_id
ON invitations (project_id);

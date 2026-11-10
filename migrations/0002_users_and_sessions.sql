-- Migration 0002: users and sessions schema

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  app_role      TEXT        NOT NULL CHECK (app_role IN ('user', 'store_manager', 'super_admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness for user email (context.md rule 78)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash          TEXT NOT NULL,
  previous_refresh_token_hash TEXT,
  is_revoked                  BOOLEAN NOT NULL DEFAULT false,
  revoked_at                  TIMESTAMPTZ,
  expires_at                  TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);

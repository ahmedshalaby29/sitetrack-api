-- Migration 0001: schema_migrations tracking table
-- This is the only migration that bootstraps the runner itself.
-- All subsequent migrations are applied exactly once, tracked here.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT        NOT NULL PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

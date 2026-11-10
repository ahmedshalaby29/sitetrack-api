-- Migration 0004: counters and stores schema

-- Counters table for sequential ID allocation (context.md rule 93)
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT   NOT NULL PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

-- Seed project counter if not present
INSERT INTO counters (name, value)
VALUES ('project', 0)
ON CONFLICT (name) DO NOTHING;

-- Stores table: one company store (project_id IS NULL), plus one row per project
CREATE TABLE IF NOT EXISTS stores (
  id         BIGSERIAL   PRIMARY KEY,
  project_id BIGINT      UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one company store allowed
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_company_store
ON stores ((project_id IS NULL))
WHERE project_id IS NULL;

-- Seed the company store
INSERT INTO stores (project_id, name)
VALUES (NULL, 'Company Store')
ON CONFLICT DO NOTHING;

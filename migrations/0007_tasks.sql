-- Migration 0007: tasks schema

CREATE TABLE IF NOT EXISTS tasks (
  project_id   BIGINT       NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       BIGINT       NOT NULL,
  name         TEXT         NOT NULL,
  description  TEXT         NOT NULL DEFAULT '',
  status       TEXT         NOT NULL DEFAULT 'not_started'
                            CHECK (status IN ('not_started', 'in_progress', 'done')),
  blocked      BOOLEAN      NOT NULL DEFAULT false,
  start_date   DATE         NOT NULL,
  end_date     DATE         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, number),
  CONSTRAINT chk_task_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status
ON tasks (project_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_project_dates
ON tasks (project_id, start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_tasks_name_trgm
ON tasks USING gin (name gin_trgm_ops);

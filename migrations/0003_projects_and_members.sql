-- Migration 0003: projects and project_members schema

CREATE TABLE IF NOT EXISTS projects (
  id                  BIGSERIAL PRIMARY KEY,
  name                TEXT        NOT NULL,
  description         TEXT,
  is_deleted          BOOLEAN     NOT NULL DEFAULT false,
  deleted_at          TIMESTAMPTZ,
  created_by_user_id  BIGINT      NOT NULL REFERENCES users(id),
  task_seq            BIGINT      NOT NULL DEFAULT 0,
  start_date          DATE,
  end_date            DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_not_deleted ON projects (id) WHERE NOT is_deleted;

CREATE TABLE IF NOT EXISTS project_members (
  project_id  BIGINT      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin    BOOLEAN     NOT NULL DEFAULT false,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members (user_id);

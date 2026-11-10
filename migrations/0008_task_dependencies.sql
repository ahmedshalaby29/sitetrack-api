-- Migration 0008: task dependencies schema

CREATE TABLE IF NOT EXISTS task_dependencies (
  project_id         BIGINT NOT NULL,
  task_number        BIGINT NOT NULL,
  depends_on_number  BIGINT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, task_number, depends_on_number),
  CONSTRAINT chk_no_self_dependency CHECK (task_number <> depends_on_number),
  CONSTRAINT fk_task_dependencies_task
    FOREIGN KEY (project_id, task_number)
    REFERENCES tasks (project_id, number)
    ON DELETE CASCADE,
  CONSTRAINT fk_task_dependencies_prereq
    FOREIGN KEY (project_id, depends_on_number)
    REFERENCES tasks (project_id, number)
    ON DELETE CASCADE
);

-- Index for reverse lookup: finding tasks that depend on a given task (rule 101)
CREATE INDEX IF NOT EXISTS idx_task_dependencies_reverse
ON task_dependencies (project_id, depends_on_number);

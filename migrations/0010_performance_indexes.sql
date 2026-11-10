-- Migration 0010: performance indexes from EXPLAIN analysis (rule 152-156)

-- Trigram GIN index on project name for fast substring search (Screen 4 search)
CREATE INDEX IF NOT EXISTS idx_projects_name_trgm
ON projects USING gin (name gin_trgm_ops);

-- Index for project sorting by start_date
CREATE INDEX IF NOT EXISTS idx_projects_start_date
ON projects (start_date)
WHERE NOT is_deleted;

-- Composite index on project_members for project members lookup and admin filtering
CREATE INDEX IF NOT EXISTS idx_project_members_project_admin
ON project_members (project_id, is_admin);

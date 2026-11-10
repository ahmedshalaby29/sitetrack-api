import type pg from 'pg';
import { formatProjectId } from '../../lib/ids.js';
import type {
  CreateProjectInput,
  ProjectResponse,
  UpdateProjectInput,
} from './schemas.js';

interface RawProjectRow {
  id: string;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  amIAdmin: boolean;
  memberCount: string;
  storeId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ProjectsRepo {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Creates a project atomically with its sequential counter, project admin, and store.
   * Enforces rules 93, 119:
   * - UPDATE counters SET value = value + 1 WHERE name = 'project' RETURNING value
   * - Creator is added to project_members with is_admin = true
   * - Project store is created in the same transaction
   */
  async createProject(
    userId: number,
    input: CreateProjectInput,
  ): Promise<ProjectResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Increment counter atomically
      const counterRes = await client.query<{ value: string }>(
        `UPDATE counters
         SET value = value + 1
         WHERE name = 'project'
         RETURNING value`,
      );
      const counterRow = counterRes.rows[0];
      if (!counterRow) {
        throw new Error('Project counter not initialized');
      }
      const nextId = Number(counterRow.value);

      // 2. Insert project with sequential integer ID
      const projRes = await client.query<{
        id: string;
        name: string;
        description: string | null;
        startDate: string | null;
        endDate: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>(
        `INSERT INTO projects (
           id,
           name,
           description,
           created_by_user_id,
           start_date,
           end_date
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING
           id,
           name,
           description,
           start_date::text AS "startDate",
           end_date::text AS "endDate",
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          nextId,
          input.name,
          input.description ?? null,
          userId,
          input.startDate ?? null,
          input.endDate ?? null,
        ],
      );
      const proj = projRes.rows[0];
      if (!proj) {
        throw new Error('Failed to insert project');
      }

      // 3. Creator is automatically a project admin (decision 5, context rule)
      await client.query(
        `INSERT INTO project_members (project_id, user_id, is_admin)
         VALUES ($1, $2, true)`,
        [nextId, userId],
      );

      // 4. Create dedicated project store (rule 119)
      const storeRes = await client.query<{ id: string }>(
        `INSERT INTO stores (project_id, name)
         VALUES ($1, $2)
         RETURNING id`,
        [nextId, `${input.name} Store`],
      );
      const storeId = Number(storeRes.rows[0]?.id);

      await client.query('COMMIT');

      return {
        id: formatProjectId(nextId),
        name: proj.name,
        description: proj.description,
        startDate: proj.startDate,
        endDate: proj.endDate,
        amIAdmin: true,
        memberCount: 1,
        storeId,
        createdAt: proj.createdAt.toISOString(),
        updatedAt: proj.updatedAt.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Fetches an accessible project by ID.
   */
  async getProjectById(
    projectId: number,
    userId: number,
  ): Promise<ProjectResponse | null> {
    const res = await this.pool.query<RawProjectRow>(
      `SELECT
         p.id,
         p.name,
         p.description,
         p.start_date::text AS "startDate",
         p.end_date::text AS "endDate",
         COALESCE(m.is_admin, false) AS "amIAdmin",
         (SELECT count(*)::text FROM project_members pm WHERE pm.project_id = p.id) AS "memberCount",
         s.id AS "storeId",
         p.created_at AS "createdAt",
         p.updated_at AS "updatedAt"
       FROM projects p
       LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
       LEFT JOIN stores s ON s.project_id = p.id
       WHERE p.id = $1 AND NOT p.is_deleted
       LIMIT 1`,
      [projectId, userId],
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      id: formatProjectId(Number(row.id)),
      name: row.name,
      description: row.description,
      startDate: row.startDate,
      endDate: row.endDate,
      amIAdmin: row.amIAdmin,
      memberCount: Number(row.memberCount),
      storeId: row.storeId ? Number(row.storeId) : undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Lists projects accessible to the caller.
   * Non-SuperAdmin only sees projects they are a member of.
   * SuperAdmin sees all non-deleted projects.
   */
  async listProjects(
    userId: number,
    isSuperAdmin: boolean,
  ): Promise<ProjectResponse[]> {
    const query = isSuperAdmin
      ? `SELECT
           p.id,
           p.name,
           p.description,
           p.start_date::text AS "startDate",
           p.end_date::text AS "endDate",
           COALESCE(m.is_admin, false) AS "amIAdmin",
           (SELECT count(*)::text FROM project_members pm WHERE pm.project_id = p.id) AS "memberCount",
           s.id AS "storeId",
           p.created_at AS "createdAt",
           p.updated_at AS "updatedAt"
         FROM projects p
         LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
         LEFT JOIN stores s ON s.project_id = p.id
         WHERE NOT p.is_deleted
         ORDER BY p.id ASC`
      : `SELECT
           p.id,
           p.name,
           p.description,
           p.start_date::text AS "startDate",
           p.end_date::text AS "endDate",
           m.is_admin AS "amIAdmin",
           (SELECT count(*)::text FROM project_members pm WHERE pm.project_id = p.id) AS "memberCount",
           s.id AS "storeId",
           p.created_at AS "createdAt",
           p.updated_at AS "updatedAt"
         FROM projects p
         JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
         LEFT JOIN stores s ON s.project_id = p.id
         WHERE NOT p.is_deleted
         ORDER BY p.id ASC`;

    const res = await this.pool.query<RawProjectRow>(query, [userId]);

    return res.rows.map((row) => ({
      id: formatProjectId(Number(row.id)),
      name: row.name,
      description: row.description,
      startDate: row.startDate,
      endDate: row.endDate,
      amIAdmin: row.amIAdmin,
      memberCount: Number(row.memberCount),
      storeId: row.storeId ? Number(row.storeId) : undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * Updates an existing project.
   */
  async updateProject(
    projectId: number,
    userId: number,
    input: UpdateProjectInput,
  ): Promise<ProjectResponse | null> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [projectId];
    let idx = 2;

    if (input.name !== undefined) {
      sets.push(`name = $${String(idx++)}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push(`description = $${String(idx++)}`);
      values.push(input.description);
    }
    if (input.startDate !== undefined) {
      sets.push(`start_date = $${String(idx++)}`);
      values.push(input.startDate);
    }
    if (input.endDate !== undefined) {
      sets.push(`end_date = $${String(idx++)}`);
      values.push(input.endDate);
    }

    await this.pool.query(
      `UPDATE projects
       SET ${sets.join(', ')}
       WHERE id = $1 AND NOT is_deleted`,
      values,
    );

    return this.getProjectById(projectId, userId);
  }

  /**
   * Soft-deletes a project (rule 67).
   */
  async softDeleteProject(projectId: number): Promise<void> {
    await this.pool.query(
      `UPDATE projects
       SET is_deleted = true,
           deleted_at = now(),
           updated_at = now()
       WHERE id = $1 AND NOT is_deleted`,
      [projectId],
    );
  }
}

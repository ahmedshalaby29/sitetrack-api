import type pg from 'pg';
import { formatProjectId, parseProjectId } from '../../lib/ids.js';
import type {
  CreateProjectInput,
  ListProjectsQuery,
  ProjectListResponse,
  ProjectResponse,
  UpdateProjectInput,
} from './schemas.js';

interface RawProjectRow {
  id: string | number;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  amIAdmin: boolean;
  memberCount: string | number;
  storeId?: string | number | null;
  totalTasks?: string | number;
  notStartedCount?: string | number;
  inProgressCount?: string | number;
  blockedCount?: string | number;
  doneCount?: string | number;
  lateCount?: string | number;
  percentDone?: string | number;
  fullCount?: string | number;
  createdAt: Date;
  updatedAt: Date;
}

export class ProjectsRepo {
  constructor(private readonly pool: pg.Pool) {}

  private mapProject(row: RawProjectRow): ProjectResponse {
    const total = Number(row.totalTasks ?? 0);
    const notStarted = Number(row.notStartedCount ?? 0);
    const inProgress = Number(row.inProgressCount ?? 0);
    const blocked = Number(row.blockedCount ?? 0);
    const done = Number(row.doneCount ?? 0);
    const late = Number(row.lateCount ?? 0);
    const pct = typeof row.percentDone === 'number' ? row.percentDone : parseFloat(String(row.percentDone ?? 0));

    return {
      id: formatProjectId(Number(row.id)),
      name: row.name,
      description: row.description,
      startDate: row.startDate,
      endDate: row.endDate,
      amIAdmin: row.amIAdmin,
      memberCount: Number(row.memberCount),
      storeId: row.storeId ? Number(row.storeId) : undefined,
      taskCounts: {
        total,
        notStarted,
        inProgress,
        blocked,
        done,
      },
      percentDone: Number.isNaN(pct) ? 0 : pct,
      lateCount: late,
      blockedCount: blocked,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

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
        taskCounts: {
          total: 0,
          notStarted: 0,
          inProgress: 0,
          blocked: 0,
          done: 0,
        },
        percentDone: 0,
        lateCount: 0,
        blockedCount: 0,
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
    now: Date = new Date(),
  ): Promise<ProjectResponse | null> {
    const todayUtc = now.toISOString().slice(0, 10);
    const res = await this.pool.query<RawProjectRow>(
      `SELECT
         p.id,
         p.name,
         p.description,
         p.start_date::text AS "startDate",
         p.end_date::text AS "endDate",
         COALESCE(caller_m.is_admin, false) AS "amIAdmin",
         COALESCE(m_stats.member_count, 0) AS "memberCount",
         s.id AS "storeId",
         COALESCE(t_stats.total_tasks, 0) AS "totalTasks",
         COALESCE(t_stats.not_started_count, 0) AS "notStartedCount",
         COALESCE(t_stats.in_progress_count, 0) AS "inProgressCount",
         COALESCE(t_stats.blocked_count, 0) AS "blockedCount",
         COALESCE(t_stats.done_count, 0) AS "doneCount",
         COALESCE(t_stats.late_count, 0) AS "lateCount",
         CASE
           WHEN COALESCE(t_stats.total_tasks, 0) > 0
           THEN ROUND((COALESCE(t_stats.done_count, 0)::numeric / t_stats.total_tasks) * 100, 1)
           ELSE 0.0
         END AS "percentDone",
         p.created_at AS "createdAt",
         p.updated_at AS "updatedAt"
       FROM projects p
       LEFT JOIN project_members caller_m ON caller_m.project_id = p.id AND caller_m.user_id = $2
       LEFT JOIN stores s ON s.project_id = p.id
       LEFT JOIN (
         SELECT pm.project_id, count(*)::int AS member_count
         FROM project_members pm
         GROUP BY pm.project_id
       ) m_stats ON m_stats.project_id = p.id
       LEFT JOIN (
         SELECT
           t.project_id,
           count(*)::int AS total_tasks,
           count(*) FILTER (WHERE t.status = 'not_started')::int AS not_started_count,
           count(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress_count,
           count(*) FILTER (WHERE t.blocked = true AND t.status != 'done')::int AS blocked_count,
           count(*) FILTER (WHERE t.status = 'done')::int AS done_count,
           count(*) FILTER (WHERE t.status != 'done' AND t.end_date < $3::date)::int AS late_count
         FROM tasks t
         GROUP BY t.project_id
       ) t_stats ON t_stats.project_id = p.id
       WHERE p.id = $1 AND NOT p.is_deleted
       LIMIT 1`,
      [projectId, userId, todayUtc],
    );

    const row = res.rows[0];
    if (!row) return null;

    return this.mapProject(row);
  }

  /**
   * Lists projects accessible to the caller (Screen 4).
   * Aggregates task counts by status, percent done, late count, blocked count, member count.
   * Search by name (trigram/substring) or id. Filter by hasLate. Sort by name/start_date/percent_done/late_tasks.
   * Non-SuperAdmin only sees projects they are a member of.
   * SuperAdmin sees all non-deleted projects.
   */
  async listProjects(
    userId: number,
    isSuperAdmin: boolean,
    query?: ListProjectsQuery,
    now: Date = new Date(),
  ): Promise<ProjectListResponse> {
    const todayUtc = now.toISOString().slice(0, 10);
    const filterClauses: string[] = ['NOT p.is_deleted'];
    const filterParams: (string | number | Date)[] = [userId, todayUtc];
    let paramIndex = 3;

    if (!isSuperAdmin) {
      filterClauses.push('caller_m.user_id IS NOT NULL');
    }

    if (query?.search) {
      const s = query.search.trim();
      const parsedId =
        parseProjectId(s) ?? (Number.isInteger(Number(s)) && Number(s) > 0 ? Number(s) : null);
      if (parsedId !== null) {
        const idIdx = paramIndex++;
        const nameIdx = paramIndex++;
        filterClauses.push(`(p.id = $${String(idIdx)} OR p.name ILIKE $${String(nameIdx)})`);
        filterParams.push(parsedId, `%${s}%`);
      } else {
        const nameIdx = paramIndex++;
        filterClauses.push(`p.name ILIKE $${String(nameIdx)}`);
        filterParams.push(`%${s}%`);
      }
    }

    if (query?.hasLate === true) {
      filterClauses.push('COALESCE(t_stats.late_count, 0) > 0');
    }

    // Determine sort clause
    let sortSql: string;
    const dir = query?.order === 'desc' ? 'DESC' : 'ASC';
    switch (query?.sort) {
      case 'name':
        sortSql = `p.name ${dir}, p.id ASC`;
        break;
      case 'start_date':
        sortSql = `p.start_date ${dir} NULLS LAST, p.id ASC`;
        break;
      case 'percent_done':
        sortSql = `(CASE WHEN COALESCE(t_stats.total_tasks, 0) > 0 THEN ROUND((COALESCE(t_stats.done_count, 0)::numeric / t_stats.total_tasks) * 100, 1) ELSE 0.0 END) ${dir}, p.id ASC`;
        break;
      case 'late_tasks':
        sortSql = `COALESCE(t_stats.late_count, 0) ${dir}, p.id ASC`;
        break;
      case 'id':
      default:
        sortSql = `p.id ${dir}`;
        break;
    }

    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const limitIdx = paramIndex++;
    const offsetIdx = paramIndex++;
    const dataParams = [...filterParams, limit, offset];

    const sql = `
      SELECT
        p.id,
        p.name,
        p.description,
        p.start_date::text AS "startDate",
        p.end_date::text AS "endDate",
        COALESCE(caller_m.is_admin, false) AS "amIAdmin",
        COALESCE(m_stats.member_count, 0) AS "memberCount",
        s.id AS "storeId",
        COALESCE(t_stats.total_tasks, 0) AS "totalTasks",
        COALESCE(t_stats.not_started_count, 0) AS "notStartedCount",
        COALESCE(t_stats.in_progress_count, 0) AS "inProgressCount",
        COALESCE(t_stats.blocked_count, 0) AS "blockedCount",
        COALESCE(t_stats.done_count, 0) AS "doneCount",
        COALESCE(t_stats.late_count, 0) AS "lateCount",
        CASE
          WHEN COALESCE(t_stats.total_tasks, 0) > 0
          THEN ROUND((COALESCE(t_stats.done_count, 0)::numeric / t_stats.total_tasks) * 100, 1)
          ELSE 0.0
        END AS "percentDone",
        count(*) OVER() AS "fullCount",
        p.created_at AS "createdAt",
        p.updated_at AS "updatedAt"
      FROM projects p
      LEFT JOIN project_members caller_m ON caller_m.project_id = p.id AND caller_m.user_id = $1
      LEFT JOIN stores s ON s.project_id = p.id
      LEFT JOIN (
        SELECT pm.project_id, count(*)::int AS member_count
        FROM project_members pm
        GROUP BY pm.project_id
      ) m_stats ON m_stats.project_id = p.id
      LEFT JOIN (
        SELECT
          t.project_id,
          count(*)::int AS total_tasks,
          count(*) FILTER (WHERE t.status = 'not_started')::int AS not_started_count,
          count(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress_count,
          count(*) FILTER (WHERE t.blocked = true AND t.status != 'done')::int AS blocked_count,
          count(*) FILTER (WHERE t.status = 'done')::int AS done_count,
          count(*) FILTER (WHERE t.status != 'done' AND t.end_date < $2::date)::int AS late_count
        FROM tasks t
        GROUP BY t.project_id
      ) t_stats ON t_stats.project_id = p.id
      WHERE ${filterClauses.join(' AND ')}
      ORDER BY ${sortSql}
      LIMIT $${String(limitIdx)} OFFSET $${String(offsetIdx)}
    `;

    const res = await this.pool.query<RawProjectRow>(sql, dataParams);
    if (res.rows.length === 0) {
      return { projects: [], total: 0 };
    }

    const total = Number(res.rows[0]?.fullCount ?? res.rows.length);
    const projects = res.rows.map((row) => this.mapProject(row));

    return {
      projects,
      total,
    };
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

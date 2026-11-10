import type { Pool } from 'pg';
import { getPool } from '../../lib/db.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { formatProjectId, formatTaskId } from '../../lib/ids.js';
import type {
  CreateTaskBody,
  ListTasksQuery,
  TaskResponse,
  TaskStatus,
  UpdateTaskBody,
} from './schemas.js';

interface TaskDbRow {
  projectId: string;
  number: string;
  name: string;
  description: string;
  status: TaskStatus;
  blocked: boolean;
  late: boolean;
  startDate: string;
  endDate: string;
  createdAt: Date;
  updatedAt: Date;
}

function mapDbRowToTask(row: TaskDbRow): TaskResponse {
  const pId = Number(row.projectId);
  const num = Number(row.number);
  return {
    id: formatTaskId(pId, num),
    number: num,
    projectId: formatProjectId(pId),
    name: row.name,
    description: row.description,
    status: row.status,
    blocked: row.blocked,
    late: row.late,
    startDate: row.startDate,
    endDate: row.endDate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class TasksRepo {
  constructor(private readonly pool: Pool = getPool()) {}

  /**
   * Creates a task with a sequential, gapless per-project number
   * using UPDATE projects SET task_seq = task_seq + 1 ... RETURNING task_seq
   * inside a single transaction (rules 94-96).
   */
  async createTask(
    projectId: number,
    input: CreateTaskBody,
    todayUtc: string,
  ): Promise<TaskResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Atomically increment task sequence for the project
      const seqRes = await client.query<{ task_seq: string }>(
        `UPDATE projects
         SET task_seq = task_seq + 1
         WHERE id = $1 AND NOT is_deleted
         RETURNING task_seq`,
        [projectId],
      );

      const seqRow = seqRes.rows[0];
      if (!seqRow) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const taskNumber = Number(seqRow.task_seq);

      // 2. Insert task
      const taskRes = await client.query<TaskDbRow>(
        `INSERT INTO tasks (
           project_id,
           number,
           name,
           description,
           start_date,
           end_date,
           status,
           blocked
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'not_started', false)
         RETURNING
           project_id AS "projectId",
           number,
           name,
           description,
           status,
           blocked,
           to_char(start_date, 'YYYY-MM-DD') AS "startDate",
           to_char(end_date, 'YYYY-MM-DD') AS "endDate",
           (start_date < $7::date) AS late,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          projectId,
          taskNumber,
          input.name,
          input.description,
          input.startDate,
          input.endDate,
          todayUtc,
        ],
      );

      await client.query('COMMIT');

      const inserted = taskRes.rows[0];
      if (!inserted) {
        throw new AppError(500, ErrorCode.INTERNAL, 'Failed to insert task');
      }

      return mapDbRowToTask(inserted);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Scoped by project_id and task_number (rule 3).
   * Derives 'late' live in SQL using injected UTC today date (rule 8 & 111).
   */
  async getTask(
    projectId: number,
    taskNumber: number,
    todayUtc: string,
  ): Promise<TaskResponse | null> {
    const res = await this.pool.query<TaskDbRow>(
      `SELECT
         t.project_id AS "projectId",
         t.number,
         t.name,
         t.description,
         t.status,
         t.blocked,
         to_char(t.start_date, 'YYYY-MM-DD') AS "startDate",
         to_char(t.end_date, 'YYYY-MM-DD') AS "endDate",
         (t.status <> 'done' AND ((t.status = 'not_started' AND t.start_date < $3::date) OR t.end_date < $3::date)) AS late,
         t.created_at AS "createdAt",
         t.updated_at AS "updatedAt"
       FROM tasks t
       WHERE t.project_id = $1 AND t.number = $2`,
      [projectId, taskNumber, todayUtc],
    );

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    return mapDbRowToTask(row);
  }

  /**
   * Lists tasks for a project with filters, live late derivation, and sorting.
   */
  async listTasks(
    projectId: number,
    query: ListTasksQuery,
    todayUtc: string,
  ): Promise<{ tasks: TaskResponse[]; total: number }> {
    const conditions: string[] = ['t.project_id = $1'];
    const filterParams: (string | number | boolean)[] = [projectId];
    let paramIndex = 2;

    if (query.status) {
      conditions.push(`t.status = $${String(paramIndex++)}`);
      filterParams.push(query.status);
    }

    if (query.blocked !== undefined) {
      conditions.push(`t.blocked = $${String(paramIndex++)}`);
      filterParams.push(query.blocked);
    }

    if (query.late !== undefined) {
      const lateExpr = `(t.status <> 'done' AND ((t.status = 'not_started' AND t.start_date < $${String(paramIndex)}::date) OR t.end_date < $${String(paramIndex)}::date))`;
      filterParams.push(todayUtc);
      paramIndex++;
      if (query.late) {
        conditions.push(lateExpr);
      } else {
        conditions.push(`NOT ${lateExpr}`);
      }
    }

    if (query.search && query.search.length > 0) {
      const numVal = Number.parseInt(query.search, 10);
      if (!Number.isNaN(numVal) && numVal > 0) {
        conditions.push(
          `(t.number = $${String(paramIndex)} OR t.name ILIKE '%' || $${String(paramIndex + 1)} || '%')`,
        );
        filterParams.push(numVal, query.search);
        paramIndex += 2;
      } else {
        conditions.push(`t.name ILIKE '%' || $${String(paramIndex++)} || '%'`);
        filterParams.push(query.search);
      }
    }

    if (query.from) {
      conditions.push(`t.start_date >= $${String(paramIndex++)}::date`);
      filterParams.push(query.from);
    }

    if (query.to) {
      conditions.push(`t.end_date <= $${String(paramIndex++)}::date`);
      filterParams.push(query.to);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Total count (uses exactly filterParams)
    const countSql = `SELECT count(*)::int AS count FROM tasks t ${whereClause}`;
    const countRes = await this.pool.query<{ count: number }>(countSql, filterParams);
    const total = countRes.rows[0]?.count ?? 0;

    // Sorting
    let sortColumn: string;
    switch (query.sort) {
      case 'name':
        sortColumn = 't.name';
        break;
      case 'start':
        sortColumn = 't.start_date';
        break;
      case 'end':
        sortColumn = 't.end_date';
        break;
      case 'status':
        sortColumn = 't.status';
        break;
      case 'id':
      default:
        sortColumn = 't.number';
        break;
    }

    const sortOrder = query.order === 'desc' ? 'DESC' : 'ASC';
    const orderBy = `${sortColumn} ${sortOrder}, t.number ASC`;

    const todayIdx = paramIndex++;
    const limitIdx = paramIndex++;
    const offsetIdx = paramIndex++;
    const dataParams = [...filterParams, todayUtc, query.limit, query.offset];

    const dataSql = `
      SELECT
        t.project_id AS "projectId",
        t.number,
        t.name,
        t.description,
        t.status,
        t.blocked,
        to_char(t.start_date, 'YYYY-MM-DD') AS "startDate",
        to_char(t.end_date, 'YYYY-MM-DD') AS "endDate",
        (t.status <> 'done' AND ((t.status = 'not_started' AND t.start_date < $${String(todayIdx)}::date) OR t.end_date < $${String(todayIdx)}::date)) AS late,
        t.created_at AS "createdAt",
        t.updated_at AS "updatedAt"
      FROM tasks t
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${String(limitIdx)} OFFSET $${String(offsetIdx)}
    `;

    const dataRes = await this.pool.query<TaskDbRow>(dataSql, dataParams);
    const tasks = dataRes.rows.map(mapDbRowToTask);

    return { tasks, total };
  }

  /**
   * Updates task metadata (name, description, start/end dates).
   */
  async updateTask(
    projectId: number,
    taskNumber: number,
    input: UpdateTaskBody,
    todayUtc: string,
  ): Promise<TaskResponse | null> {
    // First verify task exists
    const existing = await this.getTask(projectId, taskNumber, todayUtc);
    if (!existing) {
      return null;
    }

    const newStart = input.startDate ?? existing.startDate;
    const newEnd = input.endDate ?? existing.endDate;

    if (newEnd < newStart) {
      throw new AppError(
        422,
        ErrorCode.INVALID_TASK_DATES,
        'End date must be on or after start date',
      );
    }

    const res = await this.pool.query<TaskDbRow>(
      `UPDATE tasks
       SET
         name = COALESCE($3, name),
         description = COALESCE($4, description),
         start_date = COALESCE($5::date, start_date),
         end_date = COALESCE($6::date, end_date),
         updated_at = now()
       WHERE project_id = $1 AND number = $2
       RETURNING
         project_id AS "projectId",
         number,
         name,
         description,
         status,
         blocked,
         to_char(start_date, 'YYYY-MM-DD') AS "startDate",
         to_char(end_date, 'YYYY-MM-DD') AS "endDate",
         (status <> 'done' AND ((status = 'not_started' AND start_date < $7::date) OR end_date < $7::date)) AS late,
         created_at AS "createdAt",
         updated_at AS "updatedAt"`,
      [
        projectId,
        taskNumber,
        input.name ?? null,
        input.description ?? null,
        input.startDate ?? null,
        input.endDate ?? null,
        todayUtc,
      ],
    );

    const row = res.rows[0];
    if (!row) return null;

    return mapDbRowToTask(row);
  }

  /**
   * Deletes a task. Hard delete per Decision 13.
   * Returns true if deleted, false if not found.
   */
  async deleteTask(projectId: number, taskNumber: number): Promise<boolean> {
    const res = await this.pool.query<{ number: string }>(
      `DELETE FROM tasks
       WHERE project_id = $1 AND number = $2
       RETURNING number`,
      [projectId, taskNumber],
    );
    return res.rowCount !== null && res.rowCount > 0;
  }
}

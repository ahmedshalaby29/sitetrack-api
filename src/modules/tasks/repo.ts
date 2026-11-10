import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../lib/db.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { formatProjectId, formatTaskId } from '../../lib/ids.js';
import {
  computeBlockedFlags,
  getAncestors,
  getDescendants,
  wouldCreateCycle,
  type DependencyEdge,
  type TaskNode,
} from './graph.js';
import type {
  CreateTaskBody,
  ListTasksQuery,
  RelatedTask,
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
           (status <> 'done' AND ((status = 'not_started' AND start_date < $7::date) OR end_date < $7::date)) AS late,
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
   * Cascades edges and recomputes blocked flags inside project lock (Decision 6).
   */
  async deleteTask(projectId: number, taskNumber: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock project to serialize graph updates (rule 103)
      const projRes = await client.query(
        'SELECT id FROM projects WHERE id = $1 AND NOT is_deleted FOR UPDATE',
        [projectId],
      );
      if (projRes.rowCount === 0) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const res = await client.query<{ number: string }>(
        `DELETE FROM tasks
         WHERE project_id = $1 AND number = $2
         RETURNING number`,
        [projectId, taskNumber],
      );

      if (res.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      // Recompute blocked flags for remaining tasks (Decision 6 & rule 105)
      const tasksRes = await client.query<{ number: string; status: string }>(
        'SELECT number, status FROM tasks WHERE project_id = $1',
        [projectId],
      );
      const tasks: TaskNode[] = tasksRes.rows.map((r) => ({
        number: Number(r.number),
        status: r.status,
      }));

      const edgesRes = await client.query<{
        taskNumber: string;
        dependsOnNumber: string;
      }>(
        `SELECT task_number AS "taskNumber", depends_on_number AS "dependsOnNumber"
         FROM task_dependencies
         WHERE project_id = $1`,
        [projectId],
      );
      const edges: DependencyEdge[] = edgesRes.rows.map((r) => ({
        taskNumber: Number(r.taskNumber),
        dependsOnNumber: Number(r.dependsOnNumber),
      }));

      await syncBlockedFlags(client, projectId, tasks, edges);

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Adds a dependency edge (taskNumber depends on dependsOnNumber).
   * Locked under SELECT ... FROM projects WHERE id = $1 FOR UPDATE (rule 103).
   * Enforces Decision 11, cycle detection (409), and recomputes blocked flags (rule 105).
   */
  async addDependency(
    projectId: number,
    taskNumber: number,
    dependsOnNumber: number,
  ): Promise<{ taskId: string; dependsOnId: string }> {
    if (taskNumber === dependsOnNumber) {
      throw new AppError(
        400,
        ErrorCode.SELF_DEPENDENCY,
        'A task cannot depend on itself',
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Lock project row
      const projRes = await client.query(
        'SELECT id FROM projects WHERE id = $1 AND NOT is_deleted FOR UPDATE',
        [projectId],
      );
      if (projRes.rowCount === 0) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      // 2. Load all tasks in project
      const tasksRes = await client.query<{ number: string; status: string }>(
        'SELECT number, status FROM tasks WHERE project_id = $1',
        [projectId],
      );
      const tasks: TaskNode[] = tasksRes.rows.map((r) => ({
        number: Number(r.number),
        status: r.status,
      }));
      const taskMap = new Map<number, TaskNode>(tasks.map((t) => [t.number, t]));

      const targetTask = taskMap.get(taskNumber);
      const prereqTask = taskMap.get(dependsOnNumber);

      if (!targetTask || !prereqTask) {
        throw new AppError(404, ErrorCode.TASK_NOT_FOUND, 'Task not found in project');
      }

      // 3. Load all existing edges
      const edgesRes = await client.query<{
        taskNumber: string;
        dependsOnNumber: string;
      }>(
        `SELECT task_number AS "taskNumber", depends_on_number AS "dependsOnNumber"
         FROM task_dependencies
         WHERE project_id = $1`,
        [projectId],
      );
      const existingEdges: DependencyEdge[] = edgesRes.rows.map((r) => ({
        taskNumber: Number(r.taskNumber),
        dependsOnNumber: Number(r.dependsOnNumber),
      }));

      // Idempotency: if edge already exists, return ok
      const alreadyExists = existingEdges.some(
        (e) => e.taskNumber === taskNumber && e.dependsOnNumber === dependsOnNumber,
      );
      if (alreadyExists) {
        await client.query('COMMIT');
        return {
          taskId: formatTaskId(projectId, taskNumber),
          dependsOnId: formatTaskId(projectId, dependsOnNumber),
        };
      }

      // 4. In-memory cycle check (rule 103)
      if (wouldCreateCycle(existingEdges, { taskNumber, dependsOnNumber })) {
        throw new AppError(
          409,
          ErrorCode.DEPENDENCY_CYCLE,
          'Adding this dependency would create a cycle',
        );
      }

      // 5. Decision 11: rejected if task is in_progress or done while prerequisite is not done
      if (targetTask.status !== 'not_started') {
        const prereqAncestors = getAncestors(dependsOnNumber, existingEdges);
        const allPrereqNums = [dependsOnNumber, ...prereqAncestors.map((a) => a.taskNumber)];
        const notDonePrereq = allPrereqNums.find((num) => {
          const t = taskMap.get(num);
          return t?.status !== 'done';
        });

        if (notDonePrereq !== undefined) {
          throw new AppError(
            409,
            ErrorCode.PREREQUISITE_NOT_DONE,
            'Cannot add dependency: task is already started or completed but prerequisite is not done',
          );
        }
      }

      // 6. Insert edge
      await client.query(
        `INSERT INTO task_dependencies (project_id, task_number, depends_on_number)
         VALUES ($1, $2, $3)`,
        [projectId, taskNumber, dependsOnNumber],
      );

      // 7. Recompute blocked flags for whole project in the same transaction (rule 105)
      const updatedEdges = [...existingEdges, { taskNumber, dependsOnNumber }];
      await syncBlockedFlags(client, projectId, tasks, updatedEdges);

      await client.query('COMMIT');

      return {
        taskId: formatTaskId(projectId, taskNumber),
        dependsOnId: formatTaskId(projectId, dependsOnNumber),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Removes a dependency edge.
   * Locked under SELECT ... FOR UPDATE, recomputes blocked flags (rule 105).
   */
  async removeDependency(
    projectId: number,
    taskNumber: number,
    dependsOnNumber: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const projRes = await client.query(
        'SELECT id FROM projects WHERE id = $1 AND NOT is_deleted FOR UPDATE',
        [projectId],
      );
      if (projRes.rowCount === 0) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const delRes = await client.query(
        `DELETE FROM task_dependencies
         WHERE project_id = $1 AND task_number = $2 AND depends_on_number = $3`,
        [projectId, taskNumber, dependsOnNumber],
      );

      if (delRes.rowCount === 0) {
        throw new AppError(
          404,
          ErrorCode.DEPENDENCY_NOT_FOUND,
          'Dependency edge not found',
        );
      }

      // Load tasks and remaining edges, recompute blocked flags
      const tasksRes = await client.query<{ number: string; status: string }>(
        'SELECT number, status FROM tasks WHERE project_id = $1',
        [projectId],
      );
      const tasks: TaskNode[] = tasksRes.rows.map((r) => ({
        number: Number(r.number),
        status: r.status,
      }));

      const edgesRes = await client.query<{
        taskNumber: string;
        dependsOnNumber: string;
      }>(
        `SELECT task_number AS "taskNumber", depends_on_number AS "dependsOnNumber"
         FROM task_dependencies
         WHERE project_id = $1`,
        [projectId],
      );
      const remainingEdges: DependencyEdge[] = edgesRes.rows.map((r) => ({
        taskNumber: Number(r.taskNumber),
        dependsOnNumber: Number(r.dependsOnNumber),
      }));

      await syncBlockedFlags(client, projectId, tasks, remainingEdges);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Returns all transitive ancestors (prerequisites) and descendants (dependents)
   * with step distance calculated via in-memory BFS (rules 104 & 114).
   */
  async getTaskDependencies(
    projectId: number,
    taskNumber: number,
  ): Promise<{ ancestors: RelatedTask[]; descendants: RelatedTask[] }> {
    // 1. Verify task exists
    const taskRes = await this.pool.query(
      'SELECT number FROM tasks WHERE project_id = $1 AND number = $2',
      [projectId, taskNumber],
    );
    if (taskRes.rowCount === 0) {
      throw new AppError(404, ErrorCode.TASK_NOT_FOUND, 'Task not found');
    }

    // 2. Load all edges in the project
    const edgesRes = await this.pool.query<{
      taskNumber: string;
      dependsOnNumber: string;
    }>(
      `SELECT task_number AS "taskNumber", depends_on_number AS "dependsOnNumber"
       FROM task_dependencies
       WHERE project_id = $1`,
      [projectId],
    );
    const existingEdges: DependencyEdge[] = edgesRes.rows.map((r) => ({
      taskNumber: Number(r.taskNumber),
      dependsOnNumber: Number(r.dependsOnNumber),
    }));

    const ancestors = getAncestors(taskNumber, existingEdges).map((a) => ({
      id: formatTaskId(projectId, a.taskNumber),
      taskNumber: a.taskNumber,
      depth: a.depth,
    }));
    ancestors.sort((a, b) => a.depth - b.depth || a.taskNumber - b.taskNumber);

    const descendants = getDescendants(taskNumber, existingEdges).map((d) => ({
      id: formatTaskId(projectId, d.taskNumber),
      taskNumber: d.taskNumber,
      depth: d.depth,
    }));
    descendants.sort((a, b) => a.depth - b.depth || a.taskNumber - b.taskNumber);

    return {
      ancestors: ancestors.map((a) => ({ id: a.id, depth: a.depth })),
      descendants: descendants.map((d) => ({ id: d.id, depth: d.depth })),
    };
  }

  /**
   * Transitions a task's status (start, complete, reopen) under the project row lock.
   * Recomputes blocked flags for the whole project in the same transaction.
   *
   * Rules:
   * - Rule 110:
   *   - start: not_started -> in_progress, only if every transitive prerequisite is done
   *   - complete: in_progress -> done
   *   - reopen: done -> in_progress, only if no transitive dependent has started (all not_started)
   *   - Anything else rejected with 409
   * - Rule 115: locks project row (FOR UPDATE)
   * - Rule 105: recomputes blocked for the whole project in the same transaction
   */
  async transitionTaskStatus(
    projectId: number,
    taskNumber: number,
    action: 'start' | 'complete' | 'reopen',
    todayUtc: string,
  ): Promise<TaskResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Serialize all task status and graph changes via project lock (rule 115)
      const projLock = await client.query(
        'SELECT id FROM projects WHERE id = $1 FOR UPDATE',
        [projectId],
      );
      if (projLock.rowCount === 0) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      // 2. Load all tasks for the project
      const tasksRes = await client.query<{ number: string | number; status: string }>(
        'SELECT number, status FROM tasks WHERE project_id = $1',
        [projectId],
      );
      const allTasks: TaskNode[] = tasksRes.rows.map((r) => ({
        number: Number(r.number),
        status: r.status,
      }));

      const targetTask = allTasks.find((t) => t.number === taskNumber);
      if (!targetTask) {
        throw new AppError(404, ErrorCode.TASK_NOT_FOUND, 'Task not found');
      }

      // 3. Load all dependency edges
      const edgesRes = await client.query<{
        taskNumber: string | number;
        dependsOnNumber: string | number;
      }>(
        `SELECT task_number AS "taskNumber", depends_on_number AS "dependsOnNumber"
         FROM task_dependencies
         WHERE project_id = $1`,
        [projectId],
      );
      const allEdges: DependencyEdge[] = edgesRes.rows.map((r) => ({
        taskNumber: Number(r.taskNumber),
        dependsOnNumber: Number(r.dependsOnNumber),
      }));

      // 4. Validate action
      if (action === 'start') {
        if (targetTask.status !== 'not_started') {
          throw new AppError(
            409,
            ErrorCode.INVALID_STATUS_TRANSITION,
            `Cannot start task because it is already '${targetTask.status}'`,
          );
        }

        // Transitive prerequisites must all be 'done'
        const ancestors = getAncestors(taskNumber, allEdges);
        const taskMap = new Map<number, string>(allTasks.map((t) => [t.number, t.status]));
        for (const anc of ancestors) {
          const ancStatus = taskMap.get(anc.taskNumber);
          if (ancStatus !== 'done') {
            throw new AppError(
              409,
              ErrorCode.PREREQUISITE_NOT_DONE,
              `Cannot start task because prerequisite task ${formatTaskId(projectId, anc.taskNumber)} is not done`,
            );
          }
        }

        await client.query(
          `UPDATE tasks
           SET status = 'in_progress', updated_at = now()
           WHERE project_id = $1 AND number = $2`,
          [projectId, taskNumber],
        );
        targetTask.status = 'in_progress';
      } else if (action === 'complete') {
        if (targetTask.status !== 'in_progress') {
          throw new AppError(
            409,
            ErrorCode.INVALID_STATUS_TRANSITION,
            `Cannot complete task because it is '${targetTask.status}'`,
          );
        }

        await client.query(
          `UPDATE tasks
           SET status = 'done', updated_at = now()
           WHERE project_id = $1 AND number = $2`,
          [projectId, taskNumber],
        );
        targetTask.status = 'done';
      } else {
        // action === 'reopen'
        if (targetTask.status !== 'done') {
          throw new AppError(
            409,
            ErrorCode.INVALID_STATUS_TRANSITION,
            `Cannot reopen task because it is '${targetTask.status}'`,
          );
        }

        // Transitive dependents must all be 'not_started'
        const descendants = getDescendants(taskNumber, allEdges);
        const taskMap = new Map<number, string>(allTasks.map((t) => [t.number, t.status]));
        for (const desc of descendants) {
          const descStatus = taskMap.get(desc.taskNumber);
          if (descStatus !== 'not_started') {
            throw new AppError(
              409,
              ErrorCode.DEPENDENT_ALREADY_STARTED,
              `Cannot reopen task because dependent task ${formatTaskId(projectId, desc.taskNumber)} has already started`,
            );
          }
        }

        await client.query(
          `UPDATE tasks
           SET status = 'in_progress', updated_at = now()
           WHERE project_id = $1 AND number = $2`,
          [projectId, taskNumber],
        );
        targetTask.status = 'in_progress';
      }

      // 5. Recompute blocked flags across the project in the same transaction (rule 105)
      await syncBlockedFlags(client, projectId, allTasks, allEdges);

      // 6. Return updated task with derived late
      const updatedRes = await client.query<{
        projectId: number;
        number: string | number;
        name: string;
        description: string;
        status: string;
        blocked: boolean;
        startDate: string;
        endDate: string;
        late: boolean;
        createdAt: Date;
        updatedAt: Date;
      }>(
        `SELECT
           project_id AS "projectId",
           number,
           name,
           description,
           status,
           blocked,
           to_char(start_date, 'YYYY-MM-DD') AS "startDate",
           to_char(end_date, 'YYYY-MM-DD') AS "endDate",
           (status <> 'done' AND ((status = 'not_started' AND start_date < $3::date) OR end_date < $3::date)) AS late,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM tasks
         WHERE project_id = $1 AND number = $2`,
        [projectId, taskNumber, todayUtc],
      );

      await client.query('COMMIT');

      const row = updatedRes.rows[0];
      if (!row) {
        throw new AppError(404, ErrorCode.TASK_NOT_FOUND, 'Task not found');
      }
      return {
        id: formatTaskId(projectId, Number(row.number)),
        number: Number(row.number),
        projectId: formatProjectId(projectId),
        name: row.name,
        description: row.description,
        status: row.status as 'not_started' | 'in_progress' | 'done',
        blocked: row.blocked,
        late: row.late,
        startDate: row.startDate,
        endDate: row.endDate,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Batch updates the `blocked` column for tasks whose status has changed.
 */
async function syncBlockedFlags(
  client: PoolClient,
  projectId: number,
  tasks: TaskNode[],
  edges: DependencyEdge[],
): Promise<void> {
  const blockedMap = computeBlockedFlags(tasks, edges);
  const taskNums: number[] = [];
  const blockedVals: boolean[] = [];

  for (const [num, isBlocked] of blockedMap.entries()) {
    taskNums.push(num);
    blockedVals.push(isBlocked);
  }

  if (taskNums.length === 0) return;

  await client.query(
    `UPDATE tasks AS t
     SET blocked = v.blocked
     FROM (
       SELECT unnest($2::bigint[]) AS num, unnest($3::boolean[]) AS blocked
     ) AS v
     WHERE t.project_id = $1 AND t.number = v.num AND t.blocked <> v.blocked`,
    [projectId, taskNums, blockedVals],
  );
}

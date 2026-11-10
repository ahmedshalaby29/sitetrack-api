import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../../app.js';
import { FixedClock } from '../../../lib/clock.js';
import { getPool, closePool } from '../../../lib/db.js';
import { runMigrations } from '../../../lib/migrate.js';
import {
  executePermissionMatrix,
  setupPermissionTestActors,
  type MatrixRow,
  type TestActors,
} from '../../../test/permissionHarness.js';
import { TasksRepo } from '../repo.js';
import { TasksService } from '../service.js';

describe('Tasks per-project numbering, CRUD, and concurrency (real Postgres)', () => {
  const pool = getPool();
  const testClock = new FixedClock(new Date('2026-11-10T12:00:00Z'));
  const service = new TasksService(new TasksRepo(pool), testClock);
  const app = buildApp();
  let actors: TestActors;

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    testClock.setDate(new Date('2026-11-10T12:00:00Z'));
    await pool.query('TRUNCATE TABLE tasks, stores, project_members, projects, sessions, users RESTART IDENTITY CASCADE');
    await pool.query("UPDATE counters SET value = 0 WHERE name = 'project'");
    actors = await setupPermissionTestActors();
  });

  afterAll(async () => {
    await closePool();
  });

  it('creates a task with zero-padded format PRJ-XXXX-T-YYYY and initial not_started status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: {
        name: 'Excavation and Site Preparation',
        description: 'Clear site and dig foundation trench',
        startDate: '2026-11-15',
        endDate: '2026-11-25',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.task).toMatchObject({
      id: `${actors.formattedProjectId}-T-0001`,
      number: 1,
      projectId: actors.formattedProjectId,
      name: 'Excavation and Site Preparation',
      description: 'Clear site and dig foundation trench',
      status: 'not_started',
      blocked: false,
      late: false,
      startDate: '2026-11-15',
      endDate: '2026-11-25',
    });
    expect(typeof body.task.createdAt).toBe('string');
  });

  it('Rule 163 concurrency test: 50 parallel task creates yield unique, gapless numbers', async () => {
    const parallelCount = 50;

    const promises = Array.from({ length: parallelCount }, (_, i) =>
      app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/tasks`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
        payload: {
          name: `Concurrent Task ${String(i + 1)}`,
          startDate: '2026-11-15',
          endDate: '2026-11-20',
        },
      }),
    );

    const responses = await Promise.all(promises);

    // All must succeed
    for (const res of responses) {
      expect(res.statusCode).toBe(201);
    }

    const taskNumbers = responses.map(
      (r) => r.json<{ task: { number: number } }>().task.number,
    );

    // Must have 50 items
    expect(taskNumbers).toHaveLength(parallelCount);

    // Sort numbers
    taskNumbers.sort((a, b) => a - b);

    // Verify strictly consecutive and gapless: 1, 2, 3, ..., 50
    const expected = Array.from({ length: parallelCount }, (_, i) => i + 1);
    expect(taskNumbers).toEqual(expected);

    // Verify project task_seq in DB equals 50
    const projRes = await pool.query<{ task_seq: string }>(
      'SELECT task_seq FROM projects WHERE id = $1',
      [actors.projectId],
    );
    expect(Number(projRes.rows[0]?.task_seq)).toBe(50);
  });

  it('task numbering is per-project independent', async () => {
    // Create a second project
    const p2Res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { name: 'Project Beta' },
    });
    expect(p2Res.statusCode).toBe(201);
    const p2FormattedId = p2Res.json<{ id: string }>().id;

    // Create task in project 1
    const t1 = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { name: 'P1 Task 1', startDate: '2026-11-15', endDate: '2026-11-20' },
    });
    expect(t1.json<{ task: { number: number } }>().task.number).toBe(1);

    // Create task in project 2
    const t2 = await app.inject({
      method: 'POST',
      url: `/projects/${p2FormattedId}/tasks`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { name: 'P2 Task 1', startDate: '2026-11-15', endDate: '2026-11-20' },
    });
    expect(t2.json<{ task: { number: number } }>().task.number).toBe(1);

    // Second task in project 1 has number 2
    const t1_b = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { name: 'P1 Task 2', startDate: '2026-11-15', endDate: '2026-11-20' },
    });
    expect(t1_b.json<{ task: { number: number } }>().task.number).toBe(2);
  });

  it('Rule 3: accessing a valid task ID under the wrong project path returns 404', async () => {
    // Create task in Project 1
    const t1 = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { name: 'P1 Task', startDate: '2026-11-15', endDate: '2026-11-20' },
    });
    const taskId = t1.json<{ task: { id: string } }>().task.id;

    // Create Project 2
    const p2Res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { name: 'Project 2' },
    });
    const p2Id = p2Res.json<{ id: string }>().id;

    // Access P1's task under P2's path -> 404 TASK_NOT_FOUND
    const crossRes = await app.inject({
      method: 'GET',
      url: `/projects/${p2Id}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(crossRes.statusCode).toBe(404);
    expect(crossRes.json()).toMatchObject({
      error: { code: 'TASK_NOT_FOUND' },
    });
  });

  it('Rule 2: non-member access to tasks returns 404, never 403', async () => {
    // Non-member trying to list tasks gets 404
    const listRes = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks`,
      headers: { authorization: `Bearer ${actors.nonMemberToken}` },
    });
    expect(listRes.statusCode).toBe(404);
    expect(listRes.json()).toMatchObject({
      error: { code: 'PROJECT_NOT_FOUND' },
    });

    // SuperAdmin passes guard
    const saRes = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks`,
      headers: { authorization: `Bearer ${actors.superAdminToken}` },
    });
    expect(saRes.statusCode).toBe(200);
  });

  it('permission matrix: task CRUD access rules', async () => {
    const matrix: MatrixRow[] = [
      {
        name: 'List tasks (GET /projects/:projectId/tasks)',
        method: 'GET',
        path: '/projects/:projectId/tasks',
        expected: {
          nonMember: 404,
          member: 200,
          admin: 200,
          manager: 404,
          superAdmin: 200,
        },
      },
    ];

    await executePermissionMatrix(app, actors, matrix);
  });

  it('updates task metadata and deletes task', async () => {
    // Create task
    const createRes = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: {
        name: 'Initial Name',
        description: 'Initial Desc',
        startDate: '2026-11-15',
        endDate: '2026-11-20',
      },
    });
    const taskId = createRes.json<{ task: { id: string } }>().task.id;

    // PATCH update
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: {
        name: 'Updated Name',
        description: 'Updated Desc',
        endDate: '2026-11-22',
      },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json<{ task: { name: string; endDate: string } }>().task).toMatchObject({
      name: 'Updated Name',
      endDate: '2026-11-22',
    });

    // DELETE task
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ status: 'ok' });

    // Subsequent GET returns 404
    const getRes = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(getRes.statusCode).toBe(404);
  });

  it('live late derivation from clock (Rule 8, 111, Decision 12)', async () => {
    // Current date is set to 2026-11-10 in beforeEach
    // 1. Not started, start_date in future -> not late
    const t1 = await service.createTask(actors.projectId, {
      name: 'Future Task',
      description: '',
      startDate: '2026-11-15',
      endDate: '2026-11-20',
    });
    expect(t1.late).toBe(false);

    // 2. Not started, start_date in past (< 2026-11-10) -> late!
    const t2 = await service.createTask(actors.projectId, {
      name: 'Overdue Start Task',
      description: '',
      startDate: '2026-11-05',
      endDate: '2026-11-20',
    });
    expect(t2.late).toBe(true);

    // 3. Advances clock: move to 2026-11-25 -> t1's end_date is now in the past!
    testClock.setDate(new Date('2026-11-25T12:00:00Z'));
    const t1AfterAdvance = await service.getTask(actors.projectId, t1.number);
    expect(t1AfterAdvance.late).toBe(true);
  });
});

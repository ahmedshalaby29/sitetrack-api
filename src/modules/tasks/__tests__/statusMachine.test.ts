import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import { closePool, getPool } from '../../../lib/db.js';
import { runMigrations } from '../../../lib/migrate.js';
import {
  executePermissionMatrix,
  setupPermissionTestActors,
  type MatrixRow,
  type TestActors,
} from '../../../test/permissionHarness.js';

describe('Task status machine, blocked recompute, derived late (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();
  let actors: TestActors;

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE task_dependencies, tasks, stores, project_members, projects, sessions, users RESTART IDENTITY CASCADE',
    );
    await pool.query("UPDATE counters SET value = 0 WHERE name = 'project'");
    actors = await setupPermissionTestActors();
  });

  afterAll(async () => {
    await closePool();
  });

  async function createTask(
    name: string,
    startDate = '2026-12-01',
    endDate = '2026-12-10',
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: {
        name,
        description: `Description for ${name}`,
        startDate,
        endDate,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ task: { id: string } }>().task.id;
  }

  async function addDependency(taskId: string, dependsOn: string): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn },
    });
    expect(res.statusCode).toBe(201);
  }

  it('happy path: start -> complete -> reopen -> complete', async () => {
    const taskId = await createTask('Task Lifecycle');

    // 1. Initial state: not_started, not blocked, not late (future dates)
    const initial = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<{ task: { status: string; blocked: boolean } }>().task).toMatchObject({
      status: 'not_started',
      blocked: false,
    });

    // 2. Start task -> in_progress
    const startRes = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json<{ task: { status: string } }>().task.status).toBe('in_progress');

    // 3. Complete task -> done
    const completeRes = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json<{ task: { status: string } }>().task.status).toBe('done');

    // 4. Reopen task -> in_progress
    const reopenRes = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/reopen`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(reopenRes.statusCode).toBe(200);
    expect(reopenRes.json<{ task: { status: string } }>().task.status).toBe('in_progress');

    // 5. Complete task again -> done
    const completeAgainRes = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(completeAgainRes.statusCode).toBe(200);
    expect(completeAgainRes.json<{ task: { status: string } }>().task.status).toBe('done');
  });

  it('rejects invalid status transitions with 409 INVALID_STATUS_TRANSITION', async () => {
    const taskId = await createTask('Invalid Transition Task');

    // Task is not_started: cannot complete or reopen
    const completeNotStarted = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(completeNotStarted.statusCode).toBe(409);
    expect(completeNotStarted.json()).toMatchObject({
      error: { code: 'INVALID_STATUS_TRANSITION' },
    });

    const reopenNotStarted = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/reopen`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(reopenNotStarted.statusCode).toBe(409);
    expect(reopenNotStarted.json()).toMatchObject({
      error: { code: 'INVALID_STATUS_TRANSITION' },
    });

    // Start task -> in_progress
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // Task is in_progress: cannot start again or reopen
    const startInProgress = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(startInProgress.statusCode).toBe(409);
    expect(startInProgress.json()).toMatchObject({
      error: { code: 'INVALID_STATUS_TRANSITION' },
    });

    const reopenInProgress = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/reopen`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(reopenInProgress.statusCode).toBe(409);
    expect(reopenInProgress.json()).toMatchObject({
      error: { code: 'INVALID_STATUS_TRANSITION' },
    });

    // Complete task -> done
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // Task is done: cannot start or complete again
    const startDone = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(startDone.statusCode).toBe(409);
    expect(startDone.json()).toMatchObject({
      error: { code: 'INVALID_STATUS_TRANSITION' },
    });

    const completeDone = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(completeDone.statusCode).toBe(409);
    expect(completeDone.json()).toMatchObject({
      error: { code: 'INVALID_STATUS_TRANSITION' },
    });
  });

  it('prerequisite enforcement: cannot start until every transitive prerequisite is done', async () => {
    // Chain: T3 -> T2 -> T1 (T3 depends on T2, T2 depends on T1)
    const t1 = await createTask('Chain T1');
    const t2 = await createTask('Chain T2');
    const t3 = await createTask('Chain T3');

    await addDependency(t2, t1);
    await addDependency(t3, t2);

    // T2 and T3 cannot start because prerequisites are not done
    const startT2Fail = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(startT2Fail.statusCode).toBe(409);
    expect(startT2Fail.json()).toMatchObject({
      error: { code: 'PREREQUISITE_NOT_DONE' },
    });

    const startT3Fail = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t3}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(startT3Fail.statusCode).toBe(409);
    expect(startT3Fail.json()).toMatchObject({
      error: { code: 'PREREQUISITE_NOT_DONE' },
    });

    // Start T1 (T1 is now in_progress, NOT done yet)
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // T2 still cannot start because T1 is in_progress, not done
    const startT2WhileT1InProgress = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(startT2WhileT1InProgress.statusCode).toBe(409);
    expect(startT2WhileT1InProgress.json()).toMatchObject({
      error: { code: 'PREREQUISITE_NOT_DONE' },
    });

    // Complete T1 (T1 is now done)
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // Now T2 can start!
    const startT2Success = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(startT2Success.statusCode).toBe(200);

    // T3 still cannot start (waiting for T2)
    const startT3StillBlocked = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t3}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(startT3StillBlocked.statusCode).toBe(409);

    // Complete T2
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // Now T3 can start!
    const startT3Success = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t3}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(startT3Success.statusCode).toBe(200);
  });

  it('dependent enforcement: cannot reopen if any transitive dependent has started', async () => {
    // T2 depends on T1
    const t1 = await createTask('Reopen Guard T1');
    const t2 = await createTask('Reopen Guard T2');
    await addDependency(t2, t1);

    // Complete T1
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // While T2 is not_started: T1 can be reopened
    const reopenT1Success = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/reopen`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(reopenT1Success.statusCode).toBe(200);

    // Complete T1 again
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // Start T2 (T2 is now in_progress)
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // T1 cannot be reopened because dependent T2 is in_progress
    const reopenT1BlockedByInProgress = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/reopen`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(reopenT1BlockedByInProgress.statusCode).toBe(409);
    expect(reopenT1BlockedByInProgress.json()).toMatchObject({
      error: { code: 'DEPENDENT_ALREADY_STARTED' },
    });

    // Complete T2 (T2 is now done)
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // T1 still cannot be reopened because dependent T2 is done (started)
    const reopenT1BlockedByDone = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/reopen`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(reopenT1BlockedByDone.statusCode).toBe(409);
    expect(reopenT1BlockedByDone.json()).toMatchObject({
      error: { code: 'DEPENDENT_ALREADY_STARTED' },
    });
  });

  it('blocked recompute: completing prerequisite unblocks dependent; reopening re-blocks it', async () => {
    const tA = await createTask('Block Test A');
    const tB = await createTask('Block Test B');
    await addDependency(tB, tA);

    // Initially tB is blocked
    const b1 = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${tB}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(b1.json<{ task: { blocked: boolean } }>().task.blocked).toBe(true);

    // Start tA: tB still blocked
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${tA}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    const b2 = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${tB}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(b2.json<{ task: { blocked: boolean } }>().task.blocked).toBe(true);

    // Complete tA: tB automatically becomes unblocked!
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${tA}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    const b3 = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${tB}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(b3.json<{ task: { blocked: boolean } }>().task.blocked).toBe(false);

    // Reopen tA: tB automatically becomes blocked again!
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${tA}/reopen`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    const b4 = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${tB}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(b4.json<{ task: { blocked: boolean } }>().task.blocked).toBe(true);
  });

  it('derived late and both flags (blocked and late) can be true at once', async () => {
    // Create task with start_date and end_date in the past
    // Today is 2026-11-10 (or real current date), let's use 2020 dates which are guaranteed in the past
    const lateTask = await createTask('Past Dates Task', '2020-01-01', '2020-01-10');

    // not_started + start_date < today => late: true
    const checkLate1 = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${lateTask}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(checkLate1.json<{ task: { late: boolean; blocked: boolean } }>().task).toMatchObject({
      late: true,
      blocked: false,
    });

    // Add prerequisite to make it blocked as well
    const prereq = await createTask('Prereq for Past Task');
    await addDependency(lateTask, prereq);

    // Both flags true at once (rule 112)
    const checkBoth = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${lateTask}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(checkBoth.json<{ task: { late: boolean; blocked: boolean } }>().task).toMatchObject({
      late: true,
      blocked: true,
    });

    // Complete prereq so lateTask is unblocked
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${prereq}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${prereq}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });

    // Start lateTask: end_date is 2020-01-10 (< today) => still late: true
    const started = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${lateTask}/start`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(started.json<{ task: { late: boolean; blocked: boolean; status: string } }>().task).toMatchObject({
      status: 'in_progress',
      late: true,
      blocked: false,
    });

    // Complete lateTask: done is NEVER late (rule 111)
    const completed = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${lateTask}/complete`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(completed.json<{ task: { late: boolean; status: string } }>().task).toMatchObject({
      status: 'done',
      late: false,
    });
  });

  it('permission matrix: task status transition endpoints', async () => {
    const tMatrix = await createTask('Matrix Task');

    const matrix: MatrixRow[] = [
      {
        name: 'Start task (POST /projects/:projectId/tasks/:taskId/start)',
        method: 'POST',
        path: `/projects/:projectId/tasks/${tMatrix}/start`,
        expected: {
          nonMember: 404,
          member: 200,
          admin: 409, // Already started by member
          manager: 404,
          superAdmin: 409, // Already started
        },
      },
    ];

    await executePermissionMatrix(app, actors, matrix);
  });
});

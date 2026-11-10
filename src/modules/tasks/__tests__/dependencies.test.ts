import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../../app.js';
import { getPool, closePool } from '../../../lib/db.js';
import { runMigrations } from '../../../lib/migrate.js';
import {
  setupPermissionTestActors,
  type TestActors,
} from '../../../test/permissionHarness.js';

describe('Task dependencies, cycle detection, project lock, and depth (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();
  let actors: TestActors;

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE task_dependencies, tasks, stores, project_members, projects, sessions, users RESTART IDENTITY CASCADE');
    await pool.query("UPDATE counters SET value = 0 WHERE name = 'project'");
    actors = await setupPermissionTestActors();
  });

  afterAll(async () => {
    await closePool();
  });

  async function createTask(name: string, status: 'not_started' | 'in_progress' | 'done' = 'not_started'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: {
        name,
        startDate: '2026-11-15',
        endDate: '2026-11-20',
      },
    });
    expect(res.statusCode).toBe(201);
    const taskId = res.json<{ task: { id: string; number: number } }>().task.id;

    if (status !== 'not_started') {
      const taskNum = res.json<{ task: { number: number } }>().task.number;
      await pool.query(
        'UPDATE tasks SET status = $1 WHERE project_id = $2 AND number = $3',
        [status, actors.projectId, taskNum],
      );
    }

    return taskId;
  }

  it('adds a valid dependency and automatically marks dependent task as blocked (Rule 105)', async () => {
    const t1 = await createTask('Task 1 - Site Prep');
    const t2 = await createTask('Task 2 - Foundation Pour');

    // Add dependency: Task 2 depends on Task 1
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t1 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ dependency: { taskId: string; dependsOnId: string } }>().dependency).toEqual({
      taskId: t2,
      dependsOnId: t1,
    });

    // Verify blocked status: Task 2 is blocked (Task 1 is not done); Task 1 is not blocked
    const t1Res = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(t1Res.json<{ task: { blocked: boolean } }>().task.blocked).toBe(false);

    const t2Res = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(t2Res.json<{ task: { blocked: boolean } }>().task.blocked).toBe(true);
  });

  it('rejects self-dependency with 400 SELF_DEPENDENCY', async () => {
    const t1 = await createTask('Self Task');

    const res = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t1 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'SELF_DEPENDENCY' },
    });
  });

  it('rejects direct and indirect cycles with 409 DEPENDENCY_CYCLE (Rule 103)', async () => {
    const t1 = await createTask('Task 1');
    const t2 = await createTask('Task 2');
    const t3 = await createTask('Task 3');

    // 2 depends on 1
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t1 },
    });

    // Direct cycle: 1 depends on 2 -> 409
    const directRes = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t2 },
    });
    expect(directRes.statusCode).toBe(409);
    expect(directRes.json()).toMatchObject({
      error: { code: 'DEPENDENCY_CYCLE' },
    });

    // 3 depends on 2
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t3}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t2 },
    });

    // Indirect cycle: 1 depends on 3 -> 409
    const indirectRes = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t3 },
    });
    expect(indirectRes.statusCode).toBe(409);
    expect(indirectRes.json()).toMatchObject({
      error: { code: 'DEPENDENCY_CYCLE' },
    });
  });

  it('Rule 167 concurrency test: opposite concurrent edges (A to B and B to A) cannot form a cycle', async () => {
    const t1 = await createTask('Task A');
    const t2 = await createTask('Task B');

    // Launch opposite edge additions simultaneously
    const [res1, res2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/tasks/${t1}/dependencies`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
        payload: { dependsOn: t2 },
      }),
      app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/tasks/${t2}/dependencies`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
        payload: { dependsOn: t1 },
      }),
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort((a, b) => a - b);
    // Exactly one winner (201) and one rejected with cycle conflict (409)
    expect(statuses).toEqual([201, 409]);

    const failed = res1.statusCode === 409 ? res1 : res2;
    expect(failed.json()).toMatchObject({
      error: { code: 'DEPENDENCY_CYCLE' },
    });
  });

  it('Decision 11: rejects adding a dependency edge if task is started/done while prerequisite is not done', async () => {
    const prereq = await createTask('Prereq - Not Done', 'not_started');
    const startedTask = await createTask('Started Task', 'in_progress');

    // Attempt to make startedTask depend on prereq (which is not done)
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${startedTask}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: prereq },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'PREREQUISITE_NOT_DONE' },
    });

    // Mark prereq as done
    await pool.query(
      "UPDATE tasks SET status = 'done' WHERE project_id = $1 AND name = 'Prereq - Not Done'",
      [actors.projectId],
    );

    // Now adding dependency succeeds
    const successRes = await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${startedTask}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: prereq },
    });
    expect(successRes.statusCode).toBe(201);
  });

  it('removes a dependency edge and recomputes blocked flags', async () => {
    const t1 = await createTask('T1');
    const t2 = await createTask('T2');

    // Add dependency
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t1 },
    });

    // Remove dependency
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/dependencies/${t1}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(delRes.statusCode).toBe(200);

    // T2 is now unblocked
    const t2Res = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(t2Res.json<{ task: { blocked: boolean } }>().task.blocked).toBe(false);
  });

  it('Decision 6: deleting a task cascades its edges and unblocks dependent tasks', async () => {
    const t1 = await createTask('Step 1');
    const t2 = await createTask('Step 2');

    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t1 },
    });

    // T2 is blocked
    const beforeDel = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(beforeDel.json<{ task: { blocked: boolean } }>().task.blocked).toBe(true);

    // Delete T1
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(delRes.statusCode).toBe(200);

    // T2 is now unblocked because its sole prerequisite was deleted
    const afterDel = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(afterDel.json<{ task: { blocked: boolean } }>().task.blocked).toBe(false);
  });

  it('GET /dependencies returns transitive ancestors and descendants with depth (diamond DAG)', async () => {
    // Build diamond graph:
    // 4 depends on 2 (depth 1) and 3 (depth 1)
    // 2 depends on 1 (depth 2 from 4)
    // 3 depends on 1 (depth 2 from 4)
    const t1 = await createTask('Foundation');
    const t2 = await createTask('Walls Left');
    const t3 = await createTask('Walls Right');
    const t4 = await createTask('Roof');

    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t2}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t1 },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t3}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t1 },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t4}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t2 },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${actors.formattedProjectId}/tasks/${t4}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
      payload: { dependsOn: t3 },
    });

    // Query dependencies of Roof (t4)
    const t4Deps = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${t4}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(t4Deps.statusCode).toBe(200);
    const body4 = t4Deps.json<{
      ancestors: { id: string; depth: number }[];
      descendants: { id: string; depth: number }[];
    }>();

    expect(body4.descendants).toEqual([]);
    expect(body4.ancestors).toEqual([
      { id: t2, depth: 1 },
      { id: t3, depth: 1 },
      { id: t1, depth: 2 },
    ]);

    // Query dependencies of Foundation (t1)
    const t1Deps = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/tasks/${t1}/dependencies`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(t1Deps.statusCode).toBe(200);
    const body1 = t1Deps.json<{
      ancestors: { id: string; depth: number }[];
      descendants: { id: string; depth: number }[];
    }>();

    expect(body1.ancestors).toEqual([]);
    expect(body1.descendants).toEqual([
      { id: t2, depth: 1 },
      { id: t3, depth: 1 },
      { id: t4, depth: 2 },
    ]);
  });
});

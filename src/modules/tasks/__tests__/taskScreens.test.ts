import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import { closePool, getPool } from '../../../lib/db.js';
import { runMigrations } from '../../../lib/migrate.js';
import {
  setupPermissionTestActors,
  type TestActors,
} from '../../../test/permissionHarness.js';
import type { TaskDetailsResponse, TaskListResponse } from '../schemas.js';

describe('Screen 5 (Project tasks list) & Screen 6 (Task details) (real Postgres)', () => {
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

  describe('Screen 5: Project tasks list (GET /projects/:projectId/tasks)', () => {
    it('returns directDependencies array and directDependentCount for each task', async () => {
      const t1 = await createTask('Task A - Foundation');
      const t2 = await createTask('Task B - Framing');
      const t3 = await createTask('Task C - Plumbing');

      // T2 depends on T1
      // T3 depends on T1 and T2
      await addDependency(t2, t1);
      await addDependency(t3, t1);
      await addDependency(t3, t2);

      const res = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<TaskListResponse>();
      expect(body.total).toBe(3);

      const taskA = body.tasks.find((t) => t.id === t1);
      const taskB = body.tasks.find((t) => t.id === t2);
      const taskC = body.tasks.find((t) => t.id === t3);

      // Task A has 0 directDependencies and 2 directDependents (B and C)
      expect(taskA?.directDependencies).toEqual([]);
      expect(taskA?.directDependentCount).toBe(2);

      // Task B has directDependency [T1] and 1 directDependent (C)
      expect(taskB?.directDependencies).toEqual([t1]);
      expect(taskB?.directDependentCount).toBe(1);

      // Task C has directDependencies [T1, T2] and 0 directDependents
      expect(taskC?.directDependencies).toEqual([t1, t2]);
      expect(taskC?.directDependentCount).toBe(0);
    });

    it('sorts by dependent_count (descending and ascending)', async () => {
      const _t1 = await createTask('Low Dependent Task');
      const t2 = await createTask('Medium Dependent Task');
      const t3 = await createTask('High Dependent Task');

      // 3 tasks depend on t3
      const d1 = await createTask('D1');
      const d2 = await createTask('D2');
      const d3 = await createTask('D3');
      await addDependency(d1, t3);
      await addDependency(d2, t3);
      await addDependency(d3, t3);

      // 1 task depends on t2
      await addDependency(d1, t2);

      // Sort desc: t3 (3 dependents), t2 (1 dependent), then others (0)
      const descRes = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks?sort=dependent_count&order=desc`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(descRes.statusCode).toBe(200);
      const descBody = descRes.json<TaskListResponse>();
      expect(descBody.tasks[0]?.id).toBe(t3);
      expect(descBody.tasks[0]?.directDependentCount).toBe(3);
      expect(descBody.tasks[1]?.id).toBe(t2);
      expect(descBody.tasks[1]?.directDependentCount).toBe(1);

      // Sort asc: tasks with 0 dependents first, t3 last
      const ascRes = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks?sort=dependent_count&order=asc`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(ascRes.statusCode).toBe(200);
      const ascBody = ascRes.json<TaskListResponse>();
      expect(ascBody.tasks[ascBody.tasks.length - 1]?.id).toBe(t3);
    });

    it('searches by formatted ID, short tag, number, and name substring', async () => {
      const t1 = await createTask('Site Excavation Special');
      const t2 = await createTask('Roof Trusses Installation');

      // Search by formatted ID PRJ-0001-T-0002
      const resFormatted = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks?search=${t2}`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(resFormatted.statusCode).toBe(200);
      const bodyFormatted = resFormatted.json<TaskListResponse>();
      expect(bodyFormatted.total).toBe(1);
      expect(bodyFormatted.tasks[0]?.id).toBe(t2);

      // Search by short tag T-0001
      const resTag = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks?search=T-0001`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(resTag.statusCode).toBe(200);
      const bodyTag = resTag.json<TaskListResponse>();
      expect(bodyTag.total).toBe(1);
      expect(bodyTag.tasks[0]?.id).toBe(t1);

      // Search by number "2"
      const resNum = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks?search=2`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(resNum.statusCode).toBe(200);
      const bodyNum = resNum.json<TaskListResponse>();
      expect(bodyNum.tasks.some((t) => t.id === t2)).toBe(true);

      // Search by name substring "excavation" (case-insensitive)
      const resName = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks?search=excavation`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(resName.statusCode).toBe(200);
      const bodyName = resName.json<TaskListResponse>();
      expect(bodyName.total).toBe(1);
      expect(bodyName.tasks[0]?.name).toBe('Site Excavation Special');
    });

    it('filters by status, late, blocked, and planned date range', async () => {
      const t1 = await createTask('T1 - Blocked & Late', '2020-01-01', '2020-01-10');
      const tPrereq = await createTask('TPrereq - Not Done', '2026-12-01', '2026-12-10');
      await addDependency(t1, tPrereq);

      const _t2 = await createTask('T2 - Future Clean', '2026-12-05', '2026-12-15');

      // Filter blocked=true
      const blockedRes = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks?blocked=true`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      const blockedBody = blockedRes.json<TaskListResponse>();
      expect(blockedBody.tasks.map((t) => t.id)).toEqual([t1]);

      // Filter late=true
      const lateRes = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks?late=true`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      const lateBody = lateRes.json<TaskListResponse>();
      expect(lateBody.tasks.map((t) => t.id)).toEqual([t1]);

      // Filter date range
      const rangeRes = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks?from=2026-12-01&to=2026-12-10`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      const rangeBody = rangeRes.json<TaskListResponse>();
      expect(rangeBody.tasks.map((t) => t.id)).toEqual([tPrereq]);
    });
  });

  describe('Screen 6: Task details (GET /projects/:projectId/tasks/:taskId)', () => {
    it('returns task with all transitive prerequisites, dependents with step distance, and allowedActions', async () => {
      // Diamond graph:
      // Foundation (t1) -> Walls L (t2) -> Roof (t4)
      // Foundation (t1) -> Walls R (t3) -> Roof (t4)
      const t1 = await createTask('Foundation');
      const t2 = await createTask('Walls Left');
      const t3 = await createTask('Walls Right');
      const t4 = await createTask('Roof');

      await addDependency(t2, t1);
      await addDependency(t3, t1);
      await addDependency(t4, t2);
      await addDependency(t4, t3);

      // 1. Details of Roof (t4)
      const resT4 = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks/${t4}`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(resT4.statusCode).toBe(200);
      const detailsT4 = resT4.json<TaskDetailsResponse>();

      expect(detailsT4.task.id).toBe(t4);
      expect(detailsT4.task.directDependencies).toEqual([t2, t3]);
      expect(detailsT4.task.directDependentCount).toBe(0);
      expect(detailsT4.task.blocked).toBe(true);

      // Prerequisites of Roof: t2 (depth 1), t3 (depth 1), t1 (depth 2)
      expect(detailsT4.prerequisites).toEqual([
        { id: t2, depth: 1 },
        { id: t3, depth: 1 },
        { id: t1, depth: 2 },
      ]);
      expect(detailsT4.dependents).toEqual([]);

      // Roof is not_started and prerequisites are not done -> allowedActions is []
      expect(detailsT4.allowedActions).toEqual([]);

      // 2. Details of Foundation (t1)
      const resT1 = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks/${t1}`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(resT1.statusCode).toBe(200);
      const detailsT1 = resT1.json<TaskDetailsResponse>();

      expect(detailsT1.task.id).toBe(t1);
      expect(detailsT1.prerequisites).toEqual([]);
      // Dependents of Foundation: t2 (depth 1), t3 (depth 1), t4 (depth 2)
      expect(detailsT1.dependents).toEqual([
        { id: t2, depth: 1 },
        { id: t3, depth: 1 },
        { id: t4, depth: 2 },
      ]);
      // Foundation has no prerequisites, status not_started -> allowedActions is ['start']
      expect(detailsT1.allowedActions).toEqual(['start']);
    });

    it('dynamically reflects status lifecycle and transitions in allowedActions', async () => {
      const t1 = await createTask('Solo Task');

      // 1. not_started -> ['start']
      const s1 = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks/${t1}`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(s1.json<TaskDetailsResponse>().allowedActions).toEqual(['start']);

      // 2. Start it -> in_progress -> ['complete']
      await app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/tasks/${t1}/start`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      const s2 = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks/${t1}`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(s2.json<TaskDetailsResponse>().allowedActions).toEqual(['complete']);

      // 3. Complete it -> done -> ['reopen'] (no dependents)
      await app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/tasks/${t1}/complete`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      const s3 = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks/${t1}`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(s3.json<TaskDetailsResponse>().allowedActions).toEqual(['reopen']);

      // 4. Add dependent t2 and start t2 -> t1 can no longer reopen!
      const t2 = await createTask('Dependent Task');
      await addDependency(t2, t1);
      await app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/tasks/${t2}/start`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });

      const s4 = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/tasks/${t1}`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      // Dependent started -> t1 allowedActions is now []
      expect(s4.json<TaskDetailsResponse>().allowedActions).toEqual([]);
    });
  });
});

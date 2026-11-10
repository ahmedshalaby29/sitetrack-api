import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../app.js';
import { getPool, closePool } from '../../lib/db.js';
import { runMigrations } from '../../lib/migrate.js';
import {
  projectGuard,
  requireProjectAdmin,
  requireStoreManager,
  requireSuperAdmin,
} from '../guards.js';
import {
  executePermissionMatrix,
  setupPermissionTestActors,
  type MatrixRow,
  type TestActors,
} from '../../test/permissionHarness.js';

describe('Project guard and authorization matrix (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();
  let actors: TestActors;

  beforeAll(async () => {
    // Run all migrations to have users, sessions, projects, project_members
    await runMigrations(pool);

    // Register test endpoints that exercise the guards
    app.get(
      '/projects/:projectId/info',
      { preHandler: [projectGuard] },
      async (request, reply) => {
        return reply.status(200).send({
          projectId: request.project?.id,
          isMember: request.project?.isMember,
          isAdmin: request.project?.isAdmin,
        });
      },
    );

    app.post(
      '/projects/:projectId/admin-only',
      { preHandler: [requireProjectAdmin] },
      async (_request, reply) => {
        return reply.status(200).send({ ok: true });
      },
    );

    app.get(
      '/company-store/test',
      { preHandler: [requireStoreManager] },
      async (_request, reply) => {
        return reply.status(200).send({ ok: true });
      },
    );

    app.post(
      '/admin/test',
      { preHandler: [requireSuperAdmin] },
      async (_request, reply) => {
        return reply.status(200).send({ ok: true });
      },
    );
  });

  beforeEach(async () => {
    actors = await setupPermissionTestActors();
  });

  afterAll(async () => {
    await closePool();
  });

  it('verifies RBAC and project guard via table-driven permission matrix', async () => {
    const matrix: MatrixRow[] = [
      {
        name: 'Project member resource (GET /projects/:projectId/info)',
        method: 'GET',
        path: '/projects/:projectId/info',
        expected: {
          nonMember: 404, // Rule 2: non-member access returns 404, never 403
          member: 200,
          admin: 200,
          manager: 404,   // store manager is not a member -> 404
          superAdmin: 200,// SuperAdmin passes project guard
        },
      },
      {
        name: 'Project admin-only mutation (POST /projects/:projectId/admin-only)',
        method: 'POST',
        path: '/projects/:projectId/admin-only',
        expected: {
          nonMember: 404, // non-member gets 404
          member: 403,    // member without admin gets 403
          admin: 200,     // project admin succeeds
          manager: 404,   // non-member gets 404
          superAdmin: 404,// Decision 1: SuperAdmin is not automatically a project admin (non-member -> 404)
        },
      },
      {
        name: 'Company store endpoint (GET /company-store/test)',
        method: 'GET',
        path: '/company-store/test',
        expected: {
          nonMember: 403,
          member: 403,
          admin: 403,
          manager: 200,
          superAdmin: 200,
        },
      },
      {
        name: 'SuperAdmin-only endpoint (POST /admin/test)',
        method: 'POST',
        path: '/admin/test',
        expected: {
          nonMember: 403,
          member: 403,
          admin: 403,
          manager: 403,
          superAdmin: 200,
        },
      },
    ];

    await executePermissionMatrix(app, actors, matrix);
  });

  it('returns 404 for invalid project ID format (e.g. non-PRJ or non-numeric)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/invalid-id-format/info',
      headers: { authorization: `Bearer ${actors.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { code: 'PROJECT_NOT_FOUND' },
    });
  });

  it('returns 404 for nonexistent project ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/PRJ-999999/info',
      headers: { authorization: `Bearer ${actors.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { code: 'PROJECT_NOT_FOUND' },
    });
  });

  it('returns 404 for soft-deleted project', async () => {
    // Mark project as soft-deleted
    await pool.query(
      'UPDATE projects SET is_deleted = true, deleted_at = now() WHERE id = $1',
      [actors.projectId],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/info`,
      headers: { authorization: `Bearer ${actors.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { code: 'PROJECT_NOT_FOUND' },
    });
  });

  it('returns 401 for unauthenticated request to guarded project route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/projects/${actors.formattedProjectId}/info`,
    });
    expect(res.statusCode).toBe(401);
  });
});

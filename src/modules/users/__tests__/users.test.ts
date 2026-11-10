import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../../app.js';
import { getPool, closePool } from '../../../lib/db.js';
import { runMigrations } from '../../../lib/migrate.js';
import { hashPassword } from '../../../lib/passwords.js';
import { createAccessToken, hashRefreshToken } from '../../../lib/tokens.js';
import { requireStoreManager } from '../../../plugins/guards.js';
import {
  executePermissionMatrix,
  setupPermissionTestActors,
  type MatrixRow,
  type TestActors,
} from '../../../test/permissionHarness.js';

describe('SuperAdmin user role change and next-request effect (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();
  let actors: TestActors;

  beforeAll(async () => {
    await runMigrations(pool);

    // Register a test route guarded by requireStoreManager to verify immediate role check
    app.get(
      '/test-store-manager-guarded',
      { preHandler: [requireStoreManager] },
      async (_req, reply) => {
        return reply.status(200).send({ access: 'granted' });
      },
    );
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE stores, project_members, projects, sessions, users RESTART IDENTITY CASCADE');
    await pool.query("UPDATE counters SET value = 0 WHERE name = 'project'");
    actors = await setupPermissionTestActors();
  });

  afterAll(async () => {
    await closePool();
  });

  async function createUserWithSession(name: string, email: string, role: string) {
    const pwdHash = await hashPassword('Secret123!');
    const dummyRefreshHash = hashRefreshToken('dummy_refresh_token_string_32chars');
    const expiry = new Date(Date.now() + 3600_000);

    const userRes = await pool.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash, app_role)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [name, email, pwdHash, role],
    );
    const userId = Number(userRes.rows[0]?.id);

    const sessRes = await pool.query<{ id: string }>(
      `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, dummyRefreshHash, expiry],
    );
    const sessionId = sessRes.rows[0]?.id;
    if (!sessionId) throw new Error('Session creation failed');
    const token = await createAccessToken(userId, sessionId);
    return { userId, token };
  }

  it('SuperAdmin successfully changes another user role', async () => {
    const target = await createUserWithSession('Alice', 'alice@test.com', 'user');

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${String(target.userId)}/role`,
      headers: { authorization: `Bearer ${actors.superAdminToken}` },
      payload: { role: 'store_manager' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({
      id: target.userId,
      name: 'Alice',
      email: 'alice@test.com',
      appRole: 'store_manager',
    });
    expect(typeof body.user.createdAt).toBe('string');

    // Verify in DB directly
    const dbRes = await pool.query<{ app_role: string }>(
      'SELECT app_role FROM users WHERE id = $1',
      [target.userId],
    );
    expect(dbRes.rows[0]?.app_role).toBe('store_manager');
  });

  it('Rule 1: role change takes effect immediately on the very next request without re-authenticating', async () => {
    // 1. Target user logs in as 'user'
    const target = await createUserWithSession('Bob', 'bob@test.com', 'user');

    // 2. Initial state: /me shows 'user'
    const meRes1 = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${target.token}` },
    });
    expect(meRes1.statusCode).toBe(200);
    expect(meRes1.json().role).toBe('user');

    // 3. User tries to access store manager route -> 403 FORBIDDEN
    const guardedRes1 = await app.inject({
      method: 'GET',
      url: '/test-store-manager-guarded',
      headers: { authorization: `Bearer ${target.token}` },
    });
    expect(guardedRes1.statusCode).toBe(403);

    // 4. SuperAdmin promotes target to 'store_manager'
    const promoRes = await app.inject({
      method: 'PATCH',
      url: `/users/${String(target.userId)}/role`,
      headers: { authorization: `Bearer ${actors.superAdminToken}` },
      payload: { role: 'store_manager' },
    });
    expect(promoRes.statusCode).toBe(200);

    // 5. Very next request with the exact same JWT token: /me returns 'store_manager'
    const meRes2 = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${target.token}` },
    });
    expect(meRes2.statusCode).toBe(200);
    expect(meRes2.json().role).toBe('store_manager');

    // 6. Very next request to store-manager guarded route -> 200 OK!
    const guardedRes2 = await app.inject({
      method: 'GET',
      url: '/test-store-manager-guarded',
      headers: { authorization: `Bearer ${target.token}` },
    });
    expect(guardedRes2.statusCode).toBe(200);
    expect(guardedRes2.json()).toEqual({ access: 'granted' });

    // 7. SuperAdmin revokes/demotes target back to 'user'
    const demoteRes = await app.inject({
      method: 'PATCH',
      url: `/users/${String(target.userId)}/role`,
      headers: { authorization: `Bearer ${actors.superAdminToken}` },
      payload: { role: 'user' },
    });
    expect(demoteRes.statusCode).toBe(200);

    // 8. Next request with the same JWT token is immediately rejected with 403
    const guardedRes3 = await app.inject({
      method: 'GET',
      url: '/test-store-manager-guarded',
      headers: { authorization: `Bearer ${target.token}` },
    });
    expect(guardedRes3.statusCode).toBe(403);
  });

  it('permission matrix: non-SuperAdmin cannot change roles (returns 403)', async () => {
    const target = await createUserWithSession('Target', 'target@test.com', 'user');

    const matrix: MatrixRow[] = [
      {
        name: 'Change user role (PATCH /users/:id/role)',
        method: 'PATCH',
        path: `/users/${String(target.userId)}/role`,
        payload: { role: 'store_manager' },
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

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/users/1/role',
      payload: { role: 'store_manager' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 USER_NOT_FOUND when user ID does not exist', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/users/99999999/role',
      headers: { authorization: `Bearer ${actors.superAdminToken}` },
      payload: { role: 'store_manager' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { code: 'USER_NOT_FOUND' },
    });
  });

  it('returns 400 VALIDATION on invalid role or invalid user id', async () => {
    const target = await createUserWithSession('Valid', 'valid@test.com', 'user');

    // Invalid role
    const invalidRoleRes = await app.inject({
      method: 'PATCH',
      url: `/users/${String(target.userId)}/role`,
      headers: { authorization: `Bearer ${actors.superAdminToken}` },
      payload: { role: 'invalid_role' },
    });
    expect(invalidRoleRes.statusCode).toBe(400);
    expect(invalidRoleRes.json()).toMatchObject({
      error: { code: 'VALIDATION' },
    });

    // Invalid ID (string/negative)
    const invalidIdRes = await app.inject({
      method: 'PATCH',
      url: '/users/not-a-number/role',
      headers: { authorization: `Bearer ${actors.superAdminToken}` },
      payload: { role: 'user' },
    });
    expect(invalidIdRes.statusCode).toBe(400);
  });
});

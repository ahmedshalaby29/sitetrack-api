import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../../app.js';
import { getPool, closePool } from '../../../lib/db.js';
import { parseProjectId } from '../../../lib/ids.js';
import { runMigrations } from '../../../lib/migrate.js';
import { hashPassword } from '../../../lib/passwords.js';
import { createAccessToken, hashRefreshToken } from '../../../lib/tokens.js';
import type {
  ProjectListResponse,
  ProjectResponse,
} from '../schemas.js';

describe('Project CRUD and sequential counters (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();

  let userToken: string;
  let otherUserToken: string;
  let superAdminToken: string;

  beforeAll(async () => {
    // Run all migrations to have counters, stores, projects, project_members
    await runMigrations(pool);
  });

  beforeEach(async () => {
    // Reset data
    await pool.query('TRUNCATE TABLE stores, project_members, projects, sessions, users RESTART IDENTITY CASCADE');
    await pool.query("UPDATE counters SET value = 0 WHERE name = 'project'");

    const pwdHash = await hashPassword('TestPassword123!');
    const refreshHash = hashRefreshToken('dummy_refresh_token_string_32chars');
    const expiry = new Date(Date.now() + 3600_000);

    async function createUser(email: string, role: string) {
      const uRes = await pool.query<{ id: string }>(
        `INSERT INTO users (name, email, password_hash, app_role)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['User', email, pwdHash, role],
      );
      const userId = Number(uRes.rows[0]?.id);
      const sRes = await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [userId, refreshHash, expiry],
      );
      const sessionRow = sRes.rows[0];
      if (!sessionRow) throw new Error('Session creation failed');
      const sessionId = sessionRow.id;
      return createAccessToken(userId, sessionId);
    }

    userToken = await createUser('user@test.com', 'user');
    otherUserToken = await createUser('other@test.com', 'user');
    superAdminToken = await createUser('admin@test.com', 'super_admin');
  });

  afterAll(async () => {
    await closePool();
  });

  describe('POST /projects (creation, counter, admin membership, and store)', () => {
    it('creates project with PRJ-0001, creator as admin, and project store', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          name: 'Hospital Wing A',
          description: 'Emergency ward extension',
          startDate: '2026-11-01',
          endDate: '2027-04-30',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<ProjectResponse>();
      expect(body.id).toBe('PRJ-0001');
      expect(body.name).toBe('Hospital Wing A');
      expect(body.amIAdmin).toBe(true);
      expect(body.memberCount).toBe(1);
      expect(body.startDate).toBe('2026-11-01');
      expect(body.endDate).toBe('2027-04-30');
      expect(body.storeId).toBeGreaterThan(0);

      // Verify database store was created
      const storeRes = await pool.query<{ name: string; project_id: string }>(
        'SELECT name, project_id FROM stores WHERE id = $1',
        [body.storeId],
      );
      expect(storeRes.rows[0]?.name).toBe('Hospital Wing A Store');
      expect(Number(storeRes.rows[0]?.project_id)).toBe(1);
    });

    it('rule 164: 50 parallel project creates yield unique, gapless ids', async () => {
      const total = 50;
      const promises = Array.from({ length: total }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/projects',
          headers: { authorization: `Bearer ${userToken}` },
          payload: {
            name: `Project Parallel ${String(i + 1)}`,
          },
        }),
      );

      const responses = await Promise.all(promises);
      for (const res of responses) {
        expect(res.statusCode).toBe(201);
      }

      const numericIds = responses
        .map((r) => parseProjectId(r.json<ProjectResponse>().id))
        .filter((id): id is number => id !== null)
        .sort((a, b) => a - b);

      // Unique
      expect(new Set(numericIds).size).toBe(total);
      // Gapless from 1 to 50
      expect(numericIds).toEqual(Array.from({ length: total }, (_, i) => i + 1));

      // Verify counter value in DB matches max used number
      const counterRes = await pool.query<{ value: string }>(
        "SELECT value FROM counters WHERE name = 'project'",
      );
      expect(Number(counterRes.rows[0]?.value)).toBe(total);
    });
  });

  describe('GET /projects (scoped list)', () => {
    it('regular users only see projects they are a member of (rule 4)', async () => {
      // User creates Project 1
      await app.inject({
        method: 'POST',
        url: '/projects',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { name: 'User Project' },
      });

      // Other user creates Project 2
      await app.inject({
        method: 'POST',
        url: '/projects',
        headers: { authorization: `Bearer ${otherUserToken}` },
        payload: { name: 'Other Project' },
      });

      // User list: only Project 1
      const userRes = await app.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(userRes.statusCode).toBe(200);
      const userBody = userRes.json<ProjectListResponse>();
      expect(userBody.total).toBe(1);
      expect(userBody.projects[0]?.name).toBe('User Project');

      // SuperAdmin list: sees both projects
      const adminRes = await app.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(adminRes.statusCode).toBe(200);
      const adminBody = adminRes.json<ProjectListResponse>();
      expect(adminBody.total).toBe(2);
    });
  });

  describe('GET, PATCH, DELETE /projects/:projectId', () => {
    let projectId: string;

    beforeEach(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { name: 'Main Project', description: 'Original description' },
      });
      projectId = res.json<ProjectResponse>().id;
    });

    it('member can fetch project details, non-member gets 404 (rule 2)', async () => {
      // Member access
      const memberRes = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(memberRes.statusCode).toBe(200);
      expect(memberRes.json<ProjectResponse>().name).toBe('Main Project');

      // Non-member access: exactly 404, never 403
      const nonMemberRes = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${otherUserToken}` },
      });
      expect(nonMemberRes.statusCode).toBe(404);

      // SuperAdmin passes guard
      const superAdminRes = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(superAdminRes.statusCode).toBe(200);
    });

    it('admin can update project fields', async () => {
      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          name: 'Renamed Project',
          description: 'Updated description',
        },
      });

      expect(updateRes.statusCode).toBe(200);
      const body = updateRes.json<ProjectResponse>();
      expect(body.name).toBe('Renamed Project');
      expect(body.description).toBe('Updated description');
    });

    it('soft deletes project; row kept in DB and hidden from endpoints (rule 67)', async () => {
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(delRes.statusCode).toBe(200);

      // Subsequent GET returns 404
      const getRes = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(getRes.statusCode).toBe(404);

      // Hidden from project list
      const listRes = await app.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(listRes.json<ProjectListResponse>().total).toBe(0);

      // Row still exists in database with is_deleted = true
      const numId = parseProjectId(projectId);
      const dbRes = await pool.query<{ is_deleted: boolean; deleted_at: Date }>(
        'SELECT is_deleted, deleted_at FROM projects WHERE id = $1',
        [numId],
      );
      expect(dbRes.rows[0]?.is_deleted).toBe(true);
      expect(dbRes.rows[0]?.deleted_at).toBeInstanceOf(Date);
    });
  });
});

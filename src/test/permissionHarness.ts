import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { getPool } from '../lib/db.js';
import { formatProjectId } from '../lib/ids.js';
import { hashPassword } from '../lib/passwords.js';
import { createAccessToken, hashRefreshToken } from '../lib/tokens.js';

export interface MatrixRow {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string; // e.g. '/projects/:projectId/resource'
  payload?: string | object | Buffer;
  expected: {
    nonMember: number;
    member: number;
    admin: number;
    manager: number;
    superAdmin: number;
  };
}

export interface TestActors {
  nonMemberToken: string;
  memberToken: string;
  adminToken: string;
  managerToken: string;
  superAdminToken: string;
  projectId: number;
  formattedProjectId: string;
}

/**
 * Sets up 5 standard actors and a test project in the database:
 * 1. nonMember (app_role: 'user', not in project)
 * 2. member (app_role: 'user', project member, is_admin: false)
 * 3. admin (app_role: 'user', project member, is_admin: true)
 * 4. manager (app_role: 'store_manager', non-member)
 * 5. superAdmin (app_role: 'super_admin', non-member)
 */
export async function setupPermissionTestActors(): Promise<TestActors> {
  const pool = getPool();
  const pwdHash = await hashPassword('TestPassword123!');
  const dummyRefreshHash = hashRefreshToken('dummy_refresh_token_string_32chars');
  const expiry = new Date(Date.now() + 3600_000);

  async function createActor(name: string, email: string, role: string) {
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
    const sessRow = sessRes.rows[0];
    if (!sessRow) throw new Error('Failed to create session');
    const sessionId = sessRow.id;
    const token = await createAccessToken(userId, sessionId);
    return { userId, token };
  }

  const unique = Date.now();
  const nonMember = await createActor('NonMember', `nonmember_${String(unique)}@test.com`, 'user');
  const member = await createActor('Member', `member_${String(unique)}@test.com`, 'user');
  const admin = await createActor('Admin', `admin_${String(unique)}@test.com`, 'user');
  const manager = await createActor('Manager', `manager_${String(unique)}@test.com`, 'store_manager');
  const superAdmin = await createActor('SuperAdmin', `superadmin_${String(unique)}@test.com`, 'super_admin');

  // Allocate project ID via counter (rule 93)
  const counterRes = await pool.query<{ value: string }>(
    `UPDATE counters
     SET value = value + 1
     WHERE name = 'project'
     RETURNING value`,
  );
  const counterRow = counterRes.rows[0];
  if (!counterRow) throw new Error('Counter not initialized');
  const projectId = Number(counterRow.value);
  const formattedProjectId = formatProjectId(projectId);

  await pool.query(
    `INSERT INTO projects (id, name, description, created_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [projectId, 'Test Project', 'Permission Matrix Test', admin.userId],
  );

  // Create project store (rule 121)
  await pool.query(
    `INSERT INTO stores (project_id, name)
     VALUES ($1, 'Test Project Store')`,
    [projectId],
  );

  // Add admin member
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, is_admin)
     VALUES ($1, $2, true)`,
    [projectId, admin.userId],
  );

  // Add regular member
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, is_admin)
     VALUES ($1, $2, false)`,
    [projectId, member.userId],
  );

  return {
    nonMemberToken: nonMember.token,
    memberToken: member.token,
    adminToken: admin.token,
    managerToken: manager.token,
    superAdminToken: superAdmin.token,
    projectId,
    formattedProjectId,
  };
}

/**
 * Executes a table-driven permission matrix test suite against Fastify.
 * Non-member access to project routes MUST yield 404 (rule 2).
 */
export async function executePermissionMatrix(
  app: FastifyInstance,
  actors: TestActors,
  rows: MatrixRow[],
): Promise<void> {
  for (const row of rows) {
    const resolvedPath = row.path.replace(':projectId', actors.formattedProjectId);

    const testCases: {
      actorName: string;
      token: string;
      expectedStatus: number;
    }[] = [
      { actorName: 'nonMember', token: actors.nonMemberToken, expectedStatus: row.expected.nonMember },
      { actorName: 'member', token: actors.memberToken, expectedStatus: row.expected.member },
      { actorName: 'admin', token: actors.adminToken, expectedStatus: row.expected.admin },
      { actorName: 'manager', token: actors.managerToken, expectedStatus: row.expected.manager },
      { actorName: 'superAdmin', token: actors.superAdminToken, expectedStatus: row.expected.superAdmin },
    ];

    for (const tc of testCases) {
      const injectOpts =
        row.payload !== undefined
          ? {
              method: row.method,
              url: resolvedPath,
              headers: { authorization: `Bearer ${tc.token}` },
              payload: row.payload,
            }
          : {
              method: row.method,
              url: resolvedPath,
              headers: { authorization: `Bearer ${tc.token}` },
            };

      const res = await app.inject(injectOpts);

      expect(
        res.statusCode,
        `Expected ${tc.actorName} calling ${row.method} ${resolvedPath} (${row.name}) to receive ${String(tc.expectedStatus)} but got ${String(res.statusCode)}: ${res.body}`,
      ).toBe(tc.expectedStatus);
    }
  }
}

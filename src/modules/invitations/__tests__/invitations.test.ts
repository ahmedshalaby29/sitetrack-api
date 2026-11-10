import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../../app.js';
import { getPool, closePool } from '../../../lib/db.js';
import { runMigrations } from '../../../lib/migrate.js';
import { hashPassword } from '../../../lib/passwords.js';
import { createAccessToken, hashRefreshToken } from '../../../lib/tokens.js';
import type { ProjectResponse } from '../../projects/schemas.js';
import type {
  InvitationResponse,
  NotificationListResponse,
} from '../schemas.js';
import type { ProjectMemberList } from '../../members/schemas.js';
import type { ErrorEnvelope } from '../../../lib/errors.js';

describe('Invitations, Members, Last-Admin Guard, and Notifications (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();

  let adminToken: string;
  let adminUserId: number;

  let userToken: string;
  let userId: number;

  let otherToken: string;
  let otherUserId: number;

  let projectId: string;
  let numericProjectId: number;

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE invitations, stores, project_members, projects, sessions, users RESTART IDENTITY CASCADE',
    );
    await pool.query("UPDATE counters SET value = 0 WHERE name = 'project'");

    const pwdHash = await hashPassword('TestPassword123!');
    const refreshHash = hashRefreshToken('dummy_refresh_token_string_32chars');
    const expiry = new Date(Date.now() + 3600_000);

    async function createUser(name: string, email: string, role: string) {
      const uRes = await pool.query<{ id: string }>(
        `INSERT INTO users (name, email, password_hash, app_role)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [name, email, pwdHash, role],
      );
      const uid = Number(uRes.rows[0]?.id);
      const sRes = await pool.query<{ id: string }>(
        `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [uid, refreshHash, expiry],
      );
      const sRow = sRes.rows[0];
      if (!sRow) throw new Error('Failed to create session');
      const sid = sRow.id;
      const tok = await createAccessToken(uid, sid);
      return { id: uid, token: tok };
    }

    const admin = await createUser('Admin User', 'admin@example.com', 'user');
    adminUserId = admin.id;
    adminToken = admin.token;

    const user = await createUser('Regular User', 'user@example.com', 'user');
    userId = user.id;
    userToken = user.token;

    const other = await createUser('Other User', 'other@example.com', 'user');
    otherUserId = other.id;
    otherToken = other.token;

    // Admin creates a project (admin is automatically project admin)
    const projRes = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Metro Line Extension' },
    });
    const projBody = projRes.json<ProjectResponse>();
    projectId = projBody.id;
    numericProjectId = 1;
  });

  afterAll(async () => {
    await closePool();
  });

  describe('Project Invitations (POST & DELETE /projects/:projectId/invitations)', () => {
    it('admin invites user by email; returns 201 pending invitation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { email: 'user@example.com' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<InvitationResponse>();
      expect(body.projectId).toBe(numericProjectId);
      expect(body.userEmail).toBe('user@example.com');
      expect(body.status).toBe('pending');
      expect(body.isRead).toBe(false);

      // Invited user now has 1 unread notification in header
      const meRes = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(meRes.headers['x-unread-notifications']).toBe('1');
      expect(meRes.json()).toMatchObject({ unreadNotifications: 1 });
    });

    it('rejects invitation to unknown email with 422 INVALID_INVITATION (Decision 10)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { email: 'nonexistent@example.com' },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json<ErrorEnvelope>().error.code).toBe('INVALID_INVITATION');
    });

    it('rejects inviting existing project member with 409 ALREADY_MEMBER (Decision 10)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { email: 'admin@example.com' }, // admin is already member
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorEnvelope>().error.code).toBe('ALREADY_MEMBER');
    });

    it('rejects duplicate pending invitation with 409 DUPLICATE_INVITATION (Decision 10)', async () => {
      // First invite
      await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { email: 'user@example.com' },
      });

      // Duplicate invite
      const dupRes = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { email: 'USER@EXAMPLE.COM' },
      });

      expect(dupRes.statusCode).toBe(409);
      expect(dupRes.json<ErrorEnvelope>().error.code).toBe('DUPLICATE_INVITATION');
    });

    it('admin can withdraw pending invitation; subsequent accept fails (Decision 9)', async () => {
      const invRes = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { email: 'user@example.com' },
      });
      const invId = invRes.json<InvitationResponse>().id;

      // Admin withdraws
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/projects/${projectId}/invitations/${String(invId)}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(delRes.statusCode).toBe(200);

      // User notification now shows status = withdrawn without actions
      const notifRes = await app.inject({
        method: 'GET',
        url: '/notifications',
        headers: { authorization: `Bearer ${userToken}` },
      });
      const notifs = notifRes.json<NotificationListResponse>().notifications;
      expect(notifs[0]?.status).toBe('withdrawn');

      // Attempting to accept a withdrawn invite fails with 409
      const acceptRes = await app.inject({
        method: 'POST',
        url: `/notifications/${String(invId)}/accept`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(acceptRes.statusCode).toBe(409);
      expect(acceptRes.json<ErrorEnvelope>().error.code).toBe('INVITATION_NOT_PENDING');
    });
  });

  describe('User Notifications & Answering (GET & POST /notifications)', () => {
    let invitationId: number;

    beforeEach(async () => {
      const invRes = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/invitations`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { email: 'user@example.com' },
      });
      invitationId = invRes.json<InvitationResponse>().id;
    });

    it('accepting invitation marks it accepted and adds user as project member', async () => {
      // Prior to accept, user cannot access project (404 Rule 2)
      const beforeRes = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(beforeRes.statusCode).toBe(404);

      // User accepts
      const acceptRes = await app.inject({
        method: 'POST',
        url: `/notifications/${String(invitationId)}/accept`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(acceptRes.statusCode).toBe(200);
      expect(acceptRes.json<InvitationResponse>().status).toBe('accepted');
      expect(acceptRes.json<InvitationResponse>().isRead).toBe(true);

      // User is now a project member!
      const afterRes = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(afterRes.statusCode).toBe(200);
      expect(afterRes.json<ProjectResponse>().amIAdmin).toBe(false);

      // Unread notifications counter is now 0
      const meRes = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(meRes.headers['x-unread-notifications']).toBe('0');
      expect(meRes.json()).toMatchObject({ unreadNotifications: 0 });
    });

    it('rejecting invitation marks it rejected and user does not become member', async () => {
      const rejectRes = await app.inject({
        method: 'POST',
        url: `/notifications/${String(invitationId)}/reject`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(rejectRes.statusCode).toBe(200);
      expect(rejectRes.json<InvitationResponse>().status).toBe('rejected');

      // Still 404 for project access
      const accessRes = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(accessRes.statusCode).toBe(404);
    });

    it('explicit mark-read marks notification as read (Decision 9)', async () => {
      const markRes = await app.inject({
        method: 'PATCH',
        url: `/notifications/${String(invitationId)}/read`,
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(markRes.statusCode).toBe(200);

      const meRes = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(meRes.headers['x-unread-notifications']).toBe('0');
    });
  });

  describe('Project Members & Last Admin Guard (Decision 5 & Rule 168)', () => {
    beforeEach(async () => {
      // Add user and otherUser as members to project
      await pool.query(
        `INSERT INTO project_members (project_id, user_id, is_admin)
         VALUES ($1, $2, false), ($1, $3, true)`,
        [numericProjectId, userId, otherUserId],
      );
      // Project now has:
      // admin (adminUserId): admin
      // other (otherUserId): admin
      // user (userId): non-admin member
    });

    it('lists members with admin flag', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/members`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const members = res.json<ProjectMemberList>();
      expect(members.length).toBe(3);
      expect(members.filter((m) => m.isAdmin).length).toBe(2);
    });

    it('admin can promote a member to admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/members/${String(userId)}/promote`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);

      const listRes = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/members`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const userMember = listRes.json<ProjectMemberList>().find((m) => m.userId === userId);
      expect(userMember?.isAdmin).toBe(true);
    });

    it('demoting or removing last admin is rejected with 409 LAST_PROJECT_ADMIN (Decision 5)', async () => {
      // Demote otherUser first (now only 1 admin remains: adminUserId)
      const demoteRes = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/members/${String(otherUserId)}/demote`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(demoteRes.statusCode).toBe(200);

      // Attempt to demote the last admin
      const demoteLastRes = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/members/${String(adminUserId)}/demote`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(demoteLastRes.statusCode).toBe(409);
      expect(demoteLastRes.json<ErrorEnvelope>().error.code).toBe('LAST_PROJECT_ADMIN');

      // Attempt to remove the last admin
      const removeLastRes = await app.inject({
        method: 'DELETE',
        url: `/projects/${projectId}/members/${String(adminUserId)}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(removeLastRes.statusCode).toBe(409);
      expect(removeLastRes.json<ErrorEnvelope>().error.code).toBe('LAST_PROJECT_ADMIN');
    });

    it('rule 168: two admins removing each other leaves exactly one admin', async () => {
      // Concurrently: both admins attempt to leave the project (Rule 168 & Decision 5)
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'DELETE',
          url: `/projects/${projectId}/members/${String(adminUserId)}`,
          headers: { authorization: `Bearer ${adminToken}` },
        }),
        app.inject({
          method: 'DELETE',
          url: `/projects/${projectId}/members/${String(otherUserId)}`,
          headers: { authorization: `Bearer ${otherToken}` },
        }),
      ]);

      const statuses = [res1.statusCode, res2.statusCode];
      // Exactly one must succeed (200) and one must be rejected (409)
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);

      // Verify database state: exactly 1 admin remains in the project
      const adminCountRes = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS "count"
         FROM project_members
         WHERE project_id = $1 AND is_admin = true`,
        [numericProjectId],
      );
      expect(Number(adminCountRes.rows[0]?.count)).toBe(1);
    });
  });
});

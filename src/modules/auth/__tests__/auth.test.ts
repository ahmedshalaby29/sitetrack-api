import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../../app.js';
import { getPool, closePool } from '../../../lib/db.js';
import { runMigrations } from '../../../lib/migrate.js';
import { verifyAccessToken } from '../../../lib/tokens.js';
import type { AuthResponse, MeResponse, RefreshResponse } from '../schemas.js';
import type { ErrorEnvelope } from '../../../lib/errors.js';

describe('Auth routes: register, login, refresh, logout, /me (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();

  beforeAll(async () => {
    // Ensure all migrations up to users and sessions are applied
    await runMigrations(pool);
  });

  beforeEach(async () => {
    // Clean tables between tests to ensure test isolation
    await pool.query('TRUNCATE TABLE sessions, users RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await closePool();
  });

  describe('POST /auth/register', () => {
    it('successfully registers a user with role=user and returns tokens', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Jane Builder',
          email: 'jane@example.com',
          password: 'Password123!',
          role: 'user',
        },
      });

      expect(res.statusCode).toBe(201);
      const data = res.json<AuthResponse>();

      expect(data.user.id).toBeGreaterThan(0);
      expect(data.user.name).toBe('Jane Builder');
      expect(data.user.email).toBe('jane@example.com');
      expect(data.user.role).toBe('user');
      expect(typeof data.user.createdAt).toBe('string');

      // Ensure password or hash is never returned in any field (rule 9)
      expect(data.user).not.toHaveProperty('password');
      expect(data.user).not.toHaveProperty('passwordHash');
      expect(data.user).not.toHaveProperty('password_hash');

      // Verify access token
      expect(data.accessToken).toBeTruthy();
      const payload = await verifyAccessToken(data.accessToken);
      expect(payload.sub).toBe(String(data.user.id));
      expect(payload.sid).toBeTruthy();

      // Verify refresh token is opaque string
      expect(data.refreshToken).toHaveLength(64);

      // Verify database stored hash, not plaintext
      const dbUser = await pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [data.user.id],
      );
      expect(dbUser.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);

      // Verify session exists and stores hashed refresh token
      const dbSession = await pool.query<{ refresh_token_hash: string }>(
        'SELECT refresh_token_hash FROM sessions WHERE id = $1',
        [payload.sid],
      );
      expect(dbSession.rows[0]?.refresh_token_hash).not.toBe(data.refreshToken);
      expect(dbSession.rows[0]?.refresh_token_hash).toHaveLength(64);
    });

    it('allows self-registration with store_manager or super_admin by default', async () => {
      const resManager = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Manager Bob',
          email: 'bob@example.com',
          password: 'Password123!',
          role: 'store_manager',
        },
      });
      expect(resManager.statusCode).toBe(201);
      expect(resManager.json<AuthResponse>().user.role).toBe('store_manager');

      const resAdmin = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Admin Alice',
          email: 'alice@example.com',
          password: 'Password123!',
          role: 'super_admin',
        },
      });
      expect(resAdmin.statusCode).toBe(201);
      expect(resAdmin.json<AuthResponse>().user.role).toBe('super_admin');
    });

    it('rejects privileged roles when ALLOW_PRIVILEGED_SELF_REGISTRATION=false', async () => {
      const origEnv = process.env['ALLOW_PRIVILEGED_SELF_REGISTRATION'];
      try {
        process.env['ALLOW_PRIVILEGED_SELF_REGISTRATION'] = 'false';

        const res = await app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            name: 'Sneaky Superadmin',
            email: 'sneaky@example.com',
            password: 'Password123!',
            role: 'super_admin',
          },
        });

        expect(res.statusCode).toBe(403);
        const body = res.json<ErrorEnvelope>();
        expect(body.error.code).toBe('FORBIDDEN_ROLE');
      } finally {
        if (origEnv !== undefined) {
          process.env['ALLOW_PRIVILEGED_SELF_REGISTRATION'] = origEnv;
        } else {
          delete process.env['ALLOW_PRIVILEGED_SELF_REGISTRATION'];
        }
      }
    });

    it('enforces case-insensitive email uniqueness (returns 409 EMAIL_EXISTS)', async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Original',
          email: 'user@example.com',
          password: 'Password123!',
          role: 'user',
        },
      });

      // Try registering with different casing
      const duplicateRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Duplicate',
          email: 'USER@EXAMPLE.COM',
          password: 'Password123!',
          role: 'user',
        },
      });

      expect(duplicateRes.statusCode).toBe(409);
      const body = duplicateRes.json<ErrorEnvelope>();
      expect(body.error.code).toBe('EMAIL_EXISTS');
      expect(body.error.message).toMatch(/already exists/i);
    });

    it('validates required fields and formats (returns 400 VALIDATION)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: '',
          email: 'not-an-email',
          password: 'short',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json<ErrorEnvelope>();
      expect(body.error.code).toBe('VALIDATION');
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Known User',
          email: 'known@example.com',
          password: 'CorrectPassword123!',
          role: 'user',
        },
      });
    });

    it('successfully logs in with valid credentials (case-insensitive email)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'KNOWN@EXAMPLE.COM',
          password: 'CorrectPassword123!',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<AuthResponse>();
      expect(data.user.email).toBe('known@example.com');
      expect(data.accessToken).toBeTruthy();
      expect(data.refreshToken).toBeTruthy();

      const payload = await verifyAccessToken(data.accessToken);
      expect(payload.sub).toBe(String(data.user.id));
      expect(payload.sid).toBeTruthy();
    });

    it('returns identical 401 INVALID_CREDENTIALS for unknown email and wrong password', async () => {
      // Unknown email
      const resUnknown = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'nobody@example.com',
          password: 'CorrectPassword123!',
        },
      });

      // Wrong password
      const resWrongPass = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'known@example.com',
          password: 'WrongPassword!',
        },
      });

      expect(resUnknown.statusCode).toBe(401);
      expect(resWrongPass.statusCode).toBe(401);

      const unknownBody = resUnknown.json<ErrorEnvelope>();
      const wrongPassBody = resWrongPass.json<ErrorEnvelope>();

      expect(unknownBody.error.code).toBe('INVALID_CREDENTIALS');
      expect(wrongPassBody.error.code).toBe('INVALID_CREDENTIALS');
      expect(unknownBody.error.message).toBe(wrongPassBody.error.message);
    });
  });

  describe('POST /auth/refresh (token rotation & reuse detection)', () => {
    it('successfully rotates refresh token and returns new tokens', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Refresh User',
          email: 'refresh@example.com',
          password: 'Password123!',
        },
      });
      const initialTokens = regRes.json<AuthResponse>();

      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {
          refreshToken: initialTokens.refreshToken,
        },
      });

      expect(refreshRes.statusCode).toBe(200);
      const newTokens = refreshRes.json<RefreshResponse>();
      expect(newTokens.accessToken).toBeTruthy();
      expect(newTokens.refreshToken).toBeTruthy();
      // Tokens must have been rotated (new values)
      expect(newTokens.refreshToken).not.toBe(initialTokens.refreshToken);

      // Verify the new access token is valid and shares same user and session
      const origPayload = await verifyAccessToken(initialTokens.accessToken);
      const newPayload = await verifyAccessToken(newTokens.accessToken);
      expect(newPayload.sub).toBe(origPayload.sub);
      expect(newPayload.sid).toBe(origPayload.sid);
    });

    it('revokes session immediately upon reuse of an already-rotated refresh token (rule 80)', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Reuse User',
          email: 'reuse@example.com',
          password: 'Password123!',
        },
      });
      const initialTokens = regRes.json<AuthResponse>();

      // First rotation: rotates token 1 -> token 2
      const firstRotation = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {
          refreshToken: initialTokens.refreshToken,
        },
      });
      expect(firstRotation.statusCode).toBe(200);
      const secondTokens = firstRotation.json<RefreshResponse>();

      // Attacker or stale client attempts to reuse token 1
      const reuseAttempt = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {
          refreshToken: initialTokens.refreshToken,
        },
      });
      expect(reuseAttempt.statusCode).toBe(401);
      expect(reuseAttempt.json<ErrorEnvelope>().error.code).toBe('UNAUTHENTICATED');

      // Because the whole session was revoked, even token 2 is now invalid!
      const subsequentAttempt = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {
          refreshToken: secondTokens.refreshToken,
        },
      });
      expect(subsequentAttempt.statusCode).toBe(401);
      expect(subsequentAttempt.json<ErrorEnvelope>().error.code).toBe('UNAUTHENTICATED');

      // The access token also stops working immediately
      const meRes = await app.inject({
        method: 'GET',
        url: '/me',
        headers: {
          authorization: `Bearer ${secondTokens.accessToken}`,
        },
      });
      expect(meRes.statusCode).toBe(401);
    });

    it('rejects nonexistent or invalid refresh tokens with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {
          refreshToken: '0'.repeat(64),
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<ErrorEnvelope>().error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('POST /auth/logout (session revocation)', () => {
    it('revokes the session and renders access token invalid on next request (rule 81)', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Logout User',
          email: 'logout@example.com',
          password: 'Password123!',
        },
      });
      const { accessToken } = regRes.json<AuthResponse>();

      // Verify authenticated access works before logout
      const beforeMe = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(beforeMe.statusCode).toBe(200);

      // Perform logout
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(logoutRes.statusCode).toBe(200);
      expect(logoutRes.json()).toEqual({ status: 'ok' });

      // Immediate revocation: next request with same access token fails with 401
      const afterMe = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(afterMe.statusCode).toBe(401);
      expect(afterMe.json<ErrorEnvelope>().error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('GET /me (profile and header)', () => {
    it('returns current user profile and X-Unread-Notifications header', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Me User',
          email: 'me@example.com',
          password: 'Password123!',
          role: 'user',
        },
      });
      const { accessToken, user } = regRes.json<AuthResponse>();

      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-unread-notifications']).toBe('0');

      const body = res.json<MeResponse>();
      expect(body.id).toBe(user.id);
      expect(body.name).toBe('Me User');
      expect(body.email).toBe('me@example.com');
      expect(body.role).toBe('user');
      expect(body.unreadNotifications).toBe(0);
    });

    it('reflects DB role changes on the very next request without re-issuing token (rule 1)', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          name: 'Role Change User',
          email: 'rolechange@example.com',
          password: 'Password123!',
          role: 'user',
        },
      });
      const { accessToken, user } = regRes.json<AuthResponse>();

      // Update role directly in the database (e.g. changed by SuperAdmin)
      await pool.query(
        "UPDATE users SET app_role = 'super_admin' WHERE id = $1",
        [user.id],
      );

      // On next request with old JWT, the new role is immediately active
      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<MeResponse>().role).toBe('super_admin');
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/me',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<ErrorEnvelope>().error.code).toBe('UNAUTHENTICATED');
    });
  });
});

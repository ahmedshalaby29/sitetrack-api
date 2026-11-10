import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { getPool } from '../lib/db.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';
import type { AppRole } from '../modules/auth/schemas.js';

export interface AuthContext {
  userId: number;
  sessionId: string;
  appRole: AppRole;
}

export interface UserContext {
  id: number;
  name: string;
  email: string;
  role: AppRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    user?: UserContext;
  }
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

/**
 * Loads session and user from DB on every authenticated request.
 * Enforces rule 1: Role and membership are never read from JWT.
 * Enforces rule 81: Revoked or expired sessions immediately fail with 401.
 */
async function authenticateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(
      401,
      ErrorCode.UNAUTHENTICATED,
      'Missing or malformed Bearer authorization token',
    );
  }

  const token = authHeader.slice(7).trim();
  let payload;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    throw new AppError(
      401,
      ErrorCode.UNAUTHENTICATED,
      'Invalid or expired access token',
    );
  }

  const pool = getPool();
  // Single indexed query to load session + user (rule 81)
  const res = await pool.query<{
    userId: string;
    userName: string;
    userEmail: string;
    appRole: AppRole;
    sessionId: string;
    isRevoked: boolean;
    expiresAt: Date;
  }>(
    `SELECT
       u.id AS "userId",
       u.name AS "userName",
       u.email AS "userEmail",
       u.app_role AS "appRole",
       s.id AS "sessionId",
       s.is_revoked AS "isRevoked",
       s.expires_at AS "expiresAt"
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1
     LIMIT 1`,
    [payload.sid],
  );

  const row = res.rows[0];
  if (!row || row.isRevoked || row.expiresAt < new Date()) {
    throw new AppError(
      401,
      ErrorCode.UNAUTHENTICATED,
      'Session revoked or expired',
    );
  }

  request.auth = {
    userId: Number(row.userId),
    sessionId: row.sessionId,
    appRole: row.appRole,
  };

  request.user = {
    id: Number(row.userId),
    name: row.userName,
    email: row.userEmail,
    role: row.appRole,
  };

  // Rule 69: X-Unread-Notifications header on every authenticated response
  const unreadRes = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS "count"
     FROM invitations
     WHERE user_id = $1 AND NOT is_read`,
    [row.userId],
  );
  void reply.header('X-Unread-Notifications', unreadRes.rows[0]?.count ?? '0');
}

function authPlugin(
  app: FastifyInstance,
  _opts: unknown,
  done: (err?: Error) => void,
): void {
  app.decorate('authenticate', authenticateHandler);
  done();
}

export default fp(authPlugin, {
  name: 'authPlugin',
});

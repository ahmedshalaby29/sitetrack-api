import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../lib/db.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { parseProjectId } from '../lib/ids.js';

export interface ProjectContext {
  id: number;
  isAdmin: boolean;
  isMember: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    project?: ProjectContext;
  }
}

/**
 * Project guard preHandler.
 *
 * Rules enforced:
 * - Parses PRJ-XXXX project ID (returns 404 PROJECT_NOT_FOUND on invalid format).
 * - Soft-deleted projects return 404 PROJECT_NOT_FOUND.
 * - Rule 2: Non-member access returns 404, never 403.
 * - SuperAdmin passes the guard even if not a member.
 * - Attaches request.project = { id, isAdmin, isMember }.
 */
export async function projectGuard(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Ensure authentication ran first
  if (!request.auth) {
    await request.server.authenticate(request, reply);
  }

  if (!request.auth) {
    throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
  }

  const params = request.params as { projectId?: string } | undefined;
  const rawId = params?.projectId;
  if (!rawId) {
    throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
  }

  const numericId = parseProjectId(rawId);
  if (numericId === null) {
    throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
  }

  const pool = getPool();
  // Single query loads project existence (not soft-deleted) and caller membership
  const res = await pool.query<{
    id: string;
    isMember: boolean;
    isAdmin: boolean;
  }>(
    `SELECT
       p.id,
       m.user_id IS NOT NULL AS "isMember",
       COALESCE(m.is_admin, false) AS "isAdmin"
     FROM projects p
     LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
     WHERE p.id = $1 AND NOT p.is_deleted
     LIMIT 1`,
    [numericId, request.auth.userId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
  }

  // Non-member access returns 404 PROJECT_NOT_FOUND (SuperAdmin passes guard)
  if (!row.isMember && request.auth.appRole !== 'super_admin') {
    throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
  }

  request.project = {
    id: Number(row.id),
    isMember: row.isMember,
    isAdmin: row.isAdmin,
  };
}

/**
 * Requires the caller to be an actual member of the project AND a project admin.
 * SuperAdmin is not automatically a project admin (decision 1).
 * Returns 404 for non-members, 403 for non-admin members.
 */
export async function requireProjectAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.project) {
    await projectGuard(request, reply);
  }

  const proj = request.project;
  if (!proj?.isMember) {
    throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
  }

  if (!proj.isAdmin) {
    throw new AppError(
      403,
      ErrorCode.FORBIDDEN,
      'Project admin permissions required',
    );
  }
}

/**
 * Requires store_manager or super_admin app role (used for company store routes).
 * Users without the required role get 403 FORBIDDEN.
 */
export async function requireStoreManager(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.auth) {
    await request.server.authenticate(request, reply);
  }

  const role = request.auth?.appRole;
  if (role !== 'store_manager' && role !== 'super_admin') {
    throw new AppError(
      403,
      ErrorCode.FORBIDDEN,
      'Store manager permissions required',
    );
  }
}

/**
 * Requires super_admin app role.
 */
export async function requireSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.auth) {
    await request.server.authenticate(request, reply);
  }

  if (request.auth?.appRole !== 'super_admin') {
    throw new AppError(
      403,
      ErrorCode.FORBIDDEN,
      'SuperAdmin permissions required',
    );
  }
}

import type pg from 'pg';
import { formatProjectId } from '../../lib/ids.js';
import type { InvitationResponse, InvitationStatus } from './schemas.js';

interface RawInvitationJoin {
  id: string;
  projectId: string;
  projectName: string;
  userId: string;
  userEmail: string;
  userName: string;
  invitedByUserId: string;
  invitedByUserName: string;
  status: InvitationStatus;
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class InvitationsRepo {
  constructor(private readonly pool: pg.Pool) {}

  private mapRow(row: RawInvitationJoin): InvitationResponse {
    const pId = Number(row.projectId);
    return {
      id: Number(row.id),
      projectId: pId,
      projectFormattedId: formatProjectId(pId),
      projectName: row.projectName,
      userId: Number(row.userId),
      userEmail: row.userEmail,
      userName: row.userName,
      invitedByUserId: Number(row.invitedByUserId),
      invitedByUserName: row.invitedByUserName,
      status: row.status,
      isRead: row.isRead,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async findUserByEmail(
    email: string,
  ): Promise<{ id: number; name: string; email: string } | null> {
    const res = await this.pool.query<{
      id: string;
      name: string;
      email: string;
    }>(
      `SELECT id, name, email
       FROM users
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [email],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: Number(row.id), name: row.name, email: row.email };
  }

  async isProjectMember(projectId: number, userId: number): Promise<boolean> {
    const res = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS "count"
       FROM project_members
       WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    return Number(res.rows[0]?.count ?? '0') > 0;
  }

  async createInvitation(
    projectId: number,
    userId: number,
    invitedByUserId: number,
  ): Promise<InvitationResponse> {
    const res = await this.pool.query<RawInvitationJoin>(
      `WITH ins AS (
         INSERT INTO invitations (project_id, user_id, invited_by_user_id)
         VALUES ($1, $2, $3)
         RETURNING *
       )
       SELECT
         i.id,
         i.project_id AS "projectId",
         p.name AS "projectName",
         u.id AS "userId",
         u.email AS "userEmail",
         u.name AS "userName",
         inv.id AS "invitedByUserId",
         inv.name AS "invitedByUserName",
         i.status,
         i.is_read AS "isRead",
         i.created_at AS "createdAt",
         i.updated_at AS "updatedAt"
       FROM ins i
       JOIN projects p ON p.id = i.project_id
       JOIN users u ON u.id = i.user_id
       JOIN users inv ON inv.id = i.invited_by_user_id`,
      [projectId, userId, invitedByUserId],
    );

    const row = res.rows[0];
    if (!row) throw new Error('Failed to create invitation');
    return this.mapRow(row);
  }

  async listProjectInvitations(
    projectId: number,
  ): Promise<InvitationResponse[]> {
    const res = await this.pool.query<RawInvitationJoin>(
      `SELECT
         i.id,
         i.project_id AS "projectId",
         p.name AS "projectName",
         u.id AS "userId",
         u.email AS "userEmail",
         u.name AS "userName",
         inv.id AS "invitedByUserId",
         inv.name AS "invitedByUserName",
         i.status,
         i.is_read AS "isRead",
         i.created_at AS "createdAt",
         i.updated_at AS "updatedAt"
       FROM invitations i
       JOIN projects p ON p.id = i.project_id
       JOIN users u ON u.id = i.user_id
       JOIN users inv ON inv.id = i.invited_by_user_id
       WHERE i.project_id = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [projectId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async withdrawInvitation(
    projectId: number,
    invitationId: number,
  ): Promise<boolean> {
    const res = await this.pool.query<{ id: string }>(
      `UPDATE invitations
       SET status = 'withdrawn',
           updated_at = now()
       WHERE id = $1 AND project_id = $2 AND status = 'pending'
       RETURNING id`,
      [invitationId, projectId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listUserNotifications(userId: number): Promise<InvitationResponse[]> {
    const res = await this.pool.query<RawInvitationJoin>(
      `SELECT
         i.id,
         i.project_id AS "projectId",
         p.name AS "projectName",
         u.id AS "userId",
         u.email AS "userEmail",
         u.name AS "userName",
         inv.id AS "invitedByUserId",
         inv.name AS "invitedByUserName",
         i.status,
         i.is_read AS "isRead",
         i.created_at AS "createdAt",
         i.updated_at AS "updatedAt"
       FROM invitations i
       JOIN projects p ON p.id = i.project_id
       JOIN users u ON u.id = i.user_id
       JOIN users inv ON inv.id = i.invited_by_user_id
       WHERE i.user_id = $1
       ORDER BY i.created_at DESC`,
      [userId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async acceptInvitation(
    invitationId: number,
    userId: number,
  ): Promise<InvitationResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the invitation row
      const checkRes = await client.query<{
        id: string;
        projectId: string;
        status: InvitationStatus;
      }>(
        `SELECT id, project_id AS "projectId", status
         FROM invitations
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [invitationId, userId],
      );

      const inv = checkRes.rows[0];
      if (!inv) {
        throw new Error('NOT_FOUND');
      }
      if (inv.status !== 'pending') {
        throw new Error('NOT_PENDING');
      }

      const pId = Number(inv.projectId);

      // Update invitation
      await client.query(
        `UPDATE invitations
         SET status = 'accepted',
             is_read = true,
             updated_at = now()
         WHERE id = $1`,
        [invitationId],
      );

      // Insert member
      await client.query(
        `INSERT INTO project_members (project_id, user_id, is_admin)
         VALUES ($1, $2, false)
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [pId, userId],
      );

      const detailRes = await client.query<RawInvitationJoin>(
        `SELECT
           i.id,
           i.project_id AS "projectId",
           p.name AS "projectName",
           u.id AS "userId",
           u.email AS "userEmail",
           u.name AS "userName",
           inv.id AS "invitedByUserId",
           inv.name AS "invitedByUserName",
           i.status,
           i.is_read AS "isRead",
           i.created_at AS "createdAt",
           i.updated_at AS "updatedAt"
         FROM invitations i
         JOIN projects p ON p.id = i.project_id
         JOIN users u ON u.id = i.user_id
         JOIN users inv ON inv.id = i.invited_by_user_id
         WHERE i.id = $1`,
        [invitationId],
      );

      await client.query('COMMIT');
      const row = detailRes.rows[0];
      if (!row) throw new Error('Failed to load accepted invitation');
      return this.mapRow(row);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async rejectInvitation(
    invitationId: number,
    userId: number,
  ): Promise<InvitationResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const checkRes = await client.query<{
        id: string;
        status: InvitationStatus;
      }>(
        `SELECT id, status
         FROM invitations
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [invitationId, userId],
      );

      const inv = checkRes.rows[0];
      if (!inv) throw new Error('NOT_FOUND');
      if (inv.status !== 'pending') throw new Error('NOT_PENDING');

      await client.query(
        `UPDATE invitations
         SET status = 'rejected',
             is_read = true,
             updated_at = now()
         WHERE id = $1`,
        [invitationId],
      );

      const detailRes = await client.query<RawInvitationJoin>(
        `SELECT
           i.id,
           i.project_id AS "projectId",
           p.name AS "projectName",
           u.id AS "userId",
           u.email AS "userEmail",
           u.name AS "userName",
           inv.id AS "invitedByUserId",
           inv.name AS "invitedByUserName",
           i.status,
           i.is_read AS "isRead",
           i.created_at AS "createdAt",
           i.updated_at AS "updatedAt"
         FROM invitations i
         JOIN projects p ON p.id = i.project_id
         JOIN users u ON u.id = i.user_id
         JOIN users inv ON inv.id = i.invited_by_user_id
         WHERE i.id = $1`,
        [invitationId],
      );

      await client.query('COMMIT');
      const row = detailRes.rows[0];
      if (!row) throw new Error('Failed to load rejected invitation');
      return this.mapRow(row);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async markAsRead(invitationId: number, userId: number): Promise<boolean> {
    const res = await this.pool.query<{ id: string }>(
      `UPDATE invitations
       SET is_read = true,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [invitationId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

import type pg from 'pg';
import type { ProjectMember } from './schemas.js';

export class MembersRepo {
  constructor(private readonly pool: pg.Pool) {}

  async listMembers(projectId: number): Promise<ProjectMember[]> {
    const res = await this.pool.query<{
      userId: string;
      name: string;
      email: string;
      isAdmin: boolean;
      joinedAt: Date;
    }>(
      `SELECT
         u.id AS "userId",
         u.name,
         u.email,
         pm.is_admin AS "isAdmin",
         pm.joined_at AS "joinedAt"
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1
       ORDER BY pm.is_admin DESC, pm.joined_at ASC`,
      [projectId],
    );

    return res.rows.map((row) => ({
      userId: Number(row.userId),
      name: row.name,
      email: row.email,
      isAdmin: row.isAdmin,
      joinedAt: row.joinedAt.toISOString(),
    }));
  }

  async promoteMember(projectId: number, userId: number): Promise<boolean> {
    const res = await this.pool.query<{ user_id: string }>(
      `UPDATE project_members
       SET is_admin = true
       WHERE project_id = $1 AND user_id = $2
       RETURNING user_id`,
      [projectId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Demotes a member while holding FOR UPDATE on the project row.
   * Enforces Decision 5: Cannot demote the last project admin.
   */
  async demoteMember(projectId: number, userId: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Lock the project row
      await client.query(
        `SELECT id FROM projects WHERE id = $1 FOR UPDATE`,
        [projectId],
      );

      // 2. Check if the member exists and is an admin
      const memberRes = await client.query<{ is_admin: boolean }>(
        `SELECT is_admin
         FROM project_members
         WHERE project_id = $1 AND user_id = $2`,
        [projectId, userId],
      );
      const member = memberRes.rows[0];
      if (!member) {
        throw new Error('MEMBER_NOT_FOUND');
      }

      if (member.is_admin) {
        // Count total admins
        const countRes = await client.query<{ count: string }>(
          `SELECT count(*)::text AS "count"
           FROM project_members
           WHERE project_id = $1 AND is_admin = true`,
          [projectId],
        );
        const adminCount = Number(countRes.rows[0]?.count ?? '0');
        if (adminCount <= 1) {
          throw new Error('LAST_ADMIN');
        }

        await client.query(
          `UPDATE project_members
           SET is_admin = false
           WHERE project_id = $1 AND user_id = $2`,
          [projectId, userId],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Removes a member while holding FOR UPDATE on the project row.
   * Enforces Decision 5: Cannot remove the last project admin.
   */
  async removeMember(projectId: number, userId: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Lock the project row
      await client.query(
        `SELECT id FROM projects WHERE id = $1 FOR UPDATE`,
        [projectId],
      );

      // 2. Check if the member exists
      const memberRes = await client.query<{ is_admin: boolean }>(
        `SELECT is_admin
         FROM project_members
         WHERE project_id = $1 AND user_id = $2`,
        [projectId, userId],
      );
      const member = memberRes.rows[0];
      if (!member) {
        throw new Error('MEMBER_NOT_FOUND');
      }

      if (member.is_admin) {
        // Count total admins
        const countRes = await client.query<{ count: string }>(
          `SELECT count(*)::text AS "count"
           FROM project_members
           WHERE project_id = $1 AND is_admin = true`,
          [projectId],
        );
        const adminCount = Number(countRes.rows[0]?.count ?? '0');
        if (adminCount <= 1) {
          throw new Error('LAST_ADMIN');
        }
      }

      await client.query(
        `DELETE FROM project_members
         WHERE project_id = $1 AND user_id = $2`,
        [projectId, userId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

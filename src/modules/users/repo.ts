import type { Pool } from 'pg';
import { getPool } from '../../lib/db.js';

export interface UserSummary {
  id: number;
  name: string;
  email: string;
  appRole: 'user' | 'store_manager' | 'super_admin';
  createdAt: string;
}

export async function updateUserRole(
  userId: number,
  role: 'user' | 'store_manager' | 'super_admin',
  client?: Pool,
): Promise<UserSummary | null> {
  const db = client ?? getPool();
  const res = await db.query<{
    id: string;
    name: string;
    email: string;
    appRole: 'user' | 'store_manager' | 'super_admin';
    createdAt: Date;
  }>(
    `UPDATE users
     SET app_role = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, name, email, app_role AS "appRole", created_at AS "createdAt"`,
    [userId, role],
  );

  const row = res.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    appRole: row.appRole,
    createdAt: row.createdAt.toISOString(),
  };
}

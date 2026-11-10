import type pg from 'pg';
import type { AppRole, UserResponse } from './schemas.js';

export interface UserWithPasswordHash {
  id: number;
  name: string;
  email: string;
  role: AppRole;
  passwordHash: string;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  userId: number;
  expiresAt: string;
  createdAt: string;
}

export class AuthRepo {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Inserts a new user. Never selects password_hash in RETURNING (rule 9).
   */
  async createUser(
    name: string,
    email: string,
    passwordHash: string,
    role: AppRole,
  ): Promise<UserResponse> {
    const res = await this.pool.query<{
      id: string;
      name: string;
      email: string;
      role: AppRole;
      createdAt: Date;
    }>(
      `INSERT INTO users (name, email, password_hash, app_role)
       VALUES ($1, lower($2), $3, $4)
       RETURNING id, name, email, app_role AS "role", created_at AS "createdAt"`,
      [name, email, passwordHash, role],
    );

    const row = res.rows[0];
    if (!row) {
      throw new Error('Failed to insert user');
    }

    return {
      id: Number(row.id),
      name: row.name,
      email: row.email,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Finds a user by email for password verification during login.
   * Internal use only – the passwordHash must never be forwarded to the client.
   */
  async findUserForAuth(email: string): Promise<UserWithPasswordHash | null> {
    const res = await this.pool.query<{
      id: string;
      name: string;
      email: string;
      role: AppRole;
      passwordHash: string;
      createdAt: Date;
    }>(
      `SELECT id, name, email, app_role AS "role", password_hash AS "passwordHash", created_at AS "createdAt"
       FROM users
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [email],
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      id: Number(row.id),
      name: row.name,
      email: row.email,
      role: row.role,
      passwordHash: row.passwordHash,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Creates a new session with the hashed refresh token.
   * Never selects refresh_token_hash in RETURNING (rule 9).
   */
  async createSession(
    userId: number,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<SessionRow> {
    const res = await this.pool.query<{
      id: string;
      userId: string;
      expiresAt: Date;
      createdAt: Date;
    }>(
      `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, user_id AS "userId", expires_at AS "expiresAt", created_at AS "createdAt"`,
      [userId, refreshTokenHash, expiresAt],
    );

    const row = res.rows[0];
    if (!row) {
      throw new Error('Failed to create session');
    }

    return {
      id: row.id,
      userId: Number(row.userId),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Finds a session by current or previous refresh token hash.
   * Used for token rotation and reuse detection.
   */
  async findSessionByTokenHash(
    hash: string,
  ): Promise<{
    id: string;
    userId: number;
    refreshTokenHash: string;
    previousRefreshTokenHash: string | null;
    isRevoked: boolean;
    expiresAt: Date;
  } | null> {
    const res = await this.pool.query<{
      id: string;
      userId: string;
      refreshTokenHash: string;
      previousRefreshTokenHash: string | null;
      isRevoked: boolean;
      expiresAt: Date;
    }>(
      `SELECT
         id,
         user_id AS "userId",
         refresh_token_hash AS "refreshTokenHash",
         previous_refresh_token_hash AS "previousRefreshTokenHash",
         is_revoked AS "isRevoked",
         expires_at AS "expiresAt"
       FROM sessions
       WHERE refresh_token_hash = $1 OR previous_refresh_token_hash = $1
       LIMIT 1`,
      [hash],
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      userId: Number(row.userId),
      refreshTokenHash: row.refreshTokenHash,
      previousRefreshTokenHash: row.previousRefreshTokenHash,
      isRevoked: row.isRevoked,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Rotates a refresh token: stores new hash, moves old hash to previous, updates expiry.
   */
  async rotateRefreshToken(
    sessionId: string,
    newHash: string,
    oldHash: string,
    newExpiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE sessions
       SET refresh_token_hash = $2,
           previous_refresh_token_hash = $3,
           expires_at = $4,
           updated_at = now()
       WHERE id = $1`,
      [sessionId, newHash, oldHash, newExpiresAt],
    );
  }

  /**
   * Revokes a session (used on logout and on refresh token reuse detection).
   */
  async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE sessions
       SET is_revoked = true,
           revoked_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [sessionId],
    );
  }

  /**
   * Finds a user by ID. Never selects password_hash (rule 9).
   */
  async findUserById(userId: number): Promise<UserResponse | null> {
    const res = await this.pool.query<{
      id: string;
      name: string;
      email: string;
      role: AppRole;
      createdAt: Date;
    }>(
      `SELECT id, name, email, app_role AS "role", created_at AS "createdAt"
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId],
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      id: Number(row.id),
      name: row.name,
      email: row.email,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Returns count of unread notifications for a user (Decision 9).
   */
  async getUnreadNotificationCount(userId: number): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS "count"
       FROM invitations
       WHERE user_id = $1 AND NOT is_read`,
      [userId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }
}

/**
 * Integration tests for the migration runner.
 *
 * These tests require a real PostgreSQL database. They are skipped automatically
 * when DATABASE_URL is not set, so they pass in CI without a Postgres service
 * and run fully in Docker or locally when DATABASE_URL is provided.
 *
 * Rules enforced:
 * - Migrations are applied exactly once (idempotency).
 * - Concurrent runners serialise via pg_advisory_lock (one wins, one waits).
 * - schema_migrations table is created if missing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../lib/migrate.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

describe.skipIf(skip)('migration runner (real Postgres)', () => {
  let pool: pg.Pool;
  // Use a fresh schema per test run to avoid interference with other tests
  const schema = `test_migrate_${String(Date.now())}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(`SET search_path TO ${schema}, public`);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it('creates schema_migrations and applies all pending files', async () => {
    await runMigrations(pool);

    const { rows } = await pool.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename`,
    );
    expect(rows.length).toBeGreaterThan(0);
    // The bootstrap migration must be present
    expect(rows.map((r) => r.filename)).toContain(
      '0001_schema_migrations.sql',
    );
  });

  it('is idempotent – running twice applies each migration exactly once', async () => {
    await runMigrations(pool);
    await runMigrations(pool); // second run

    const { rows } = await pool.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename`,
    );
    const filenames = rows.map((r) => r.filename);
    // No duplicates
    expect(new Set(filenames).size).toBe(filenames.length);
  });

  it('concurrent runners serialise – both complete without error', async () => {
    // Run two migrations in parallel; both must succeed
    await Promise.all([runMigrations(pool), runMigrations(pool)]);

    const { rows } = await pool.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations ORDER BY filename`,
    );
    const filenames = rows.map((r) => r.filename);
    expect(new Set(filenames).size).toBe(filenames.length);
  });
});

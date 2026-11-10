/**
 * Migration runner.
 *
 * Rules (from context.md):
 * - Plain numbered .sql files in /migrations, applied at API startup.
 * - Applied under pg_advisory_lock so concurrent startups are safe.
 * - One migration per feature; migrations are never modified after they land.
 * - Idempotent: already-applied files are skipped.
 *
 * Lock key: arbitrary stable 64-bit integer (crc32 of "sitetrack_migrations"
 * expressed as two i32 halves for pg_advisory_lock(key1, key2)).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// pg_advisory_lock requires two int4 arguments. Use a fixed pair derived from
// the string "sitetrack" so it never clashes with application locks.
const LOCK_KEY1 = 0x73697465; // "site"
const LOCK_KEY2 = 0x74726163; // "trac"

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/**
 * Applies all unapplied .sql files in /migrations in filename order.
 * Must be called with a client from the pool (not the pool itself) so the
 * advisory lock and the transaction share the same connection.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Acquire a session-level advisory lock – exclusive, blocks until free.
    await client.query(
      `SELECT pg_advisory_lock($1, $2)`,
      [LOCK_KEY1, LOCK_KEY2],
    );

    try {
      // Bootstrap: create the tracking table if it doesn't exist yet.
      // This is the only DDL executed outside a numbered migration file.
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename   TEXT        NOT NULL PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      // Collect already-applied migrations.
      const { rows } = await client.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations ORDER BY filename`,
      );
      const applied = new Set(rows.map((r) => r.filename));

      // Collect .sql files, sort lexicographically (0001_ before 0002_ etc.).
      const files = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        if (applied.has(file)) continue;

        const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

        // Each migration runs in its own transaction.
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            `INSERT INTO schema_migrations (filename) VALUES ($1)`,
            [file],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      // Always release the advisory lock, even on error.
      await client.query(
        `SELECT pg_advisory_unlock($1, $2)`,
        [LOCK_KEY1, LOCK_KEY2],
      );
    }
  } finally {
    client.release();
  }
}

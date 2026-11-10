/**
 * PostgreSQL connection pool.
 *
 * A single Pool is created from env vars and shared across the process.
 * Tests that need a real Postgres should import this module after setting
 * DATABASE_URL in the environment.
 */
import pg from 'pg';

const { Pool } = pg;

function createPool(): pg.Pool {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return new Pool({
    connectionString,
    // Keep the pool small; we are on a single small server
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

// Lazily created so importing this module in unit tests (without DATABASE_URL)
// does not throw. The pool is created on first access.
let _pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  _pool ??= createPool();
  return _pool;
}

/** Gracefully close the pool. Call on process shutdown. */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}

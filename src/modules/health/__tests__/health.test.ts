/**
 * Tests for GET /health against real PostgreSQL.
 *
 * Rules enforced:
 * - Real Postgres is used; never mock the database (rule 12).
 * - Returns 200 with status 'ok' and postgres 'ok' when database is reachable.
 * - Returns 503 with status 'degraded' and postgres 'error' when database is unreachable.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../../../app.js';
import { closePool } from '../../../lib/db.js';

describe('GET /health', () => {
  afterAll(async () => {
    await closePool();
  });

  it('returns 200 with status ok when postgres responds', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; postgres: string; uptime: number }>();
    expect(body.status).toBe('ok');
    expect(body.postgres).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 with status degraded when postgres is unreachable', async () => {
    const origUrl = process.env['DATABASE_URL'];
    try {
      await closePool();
      // Point to an unused local port to induce real connection failure without mocking
      process.env['DATABASE_URL'] = 'postgres://sitetrack:sitetrack@127.0.0.1:54329/sitetrack';

      const app = buildApp();
      const res = await app.inject({ method: 'GET', url: '/health' });

      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; postgres: string; uptime: number }>();
      expect(body.status).toBe('degraded');
      expect(body.postgres).toBe('error');
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      await closePool();
      process.env['DATABASE_URL'] = origUrl;
    }
  });

  it('response body matches the expected shape', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    const body = res.json<{ status: string; postgres: string; uptime: number }>();
    expect(['ok', 'degraded']).toContain(body.status);
    expect(['ok', 'error']).toContain(body.postgres);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});

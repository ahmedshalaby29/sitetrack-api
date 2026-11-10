import { describe, it, expect } from 'vitest';
import { buildApp } from '../../app.js';

/**
 * Integration-level tests for the error handler (no DB required).
 * These exercise the full Fastify request lifecycle via inject().
 */
describe('error handler', () => {
  it('returns 404 error envelope for unknown routes', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/nonexistent' });

    expect(res.statusCode).toBe(404);
    const body: unknown = res.json();
    expect(body).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('returns 500 error envelope for unhandled errors, without leaking internals', async () => {
    const app = buildApp();

    // Register a route that throws an unexpected error
    app.get('/boom', async () => {
      throw new Error('secret db connection string goes here');
    });

    const res = await app.inject({ method: 'GET', url: '/boom' });

    expect(res.statusCode).toBe(500);
    const body: unknown = res.json();
    expect(body).toMatchObject({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
    // The internal message must NOT leak
    expect(res.body).not.toContain('secret');
  });

  it('returns AppError status and code', async () => {
    const app = buildApp();
    const { AppError, ErrorCode } = await import('../../lib/errors.js');

    app.get('/conflict', async () => {
      throw new AppError(409, ErrorCode.CONFLICT, 'already exists');
    });

    const res = await app.inject({ method: 'GET', url: '/conflict' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'CONFLICT', message: 'already exists' },
    });
  });
});

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '../../lib/db.js';

const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  postgres: z.enum(['ok', 'error']),
  uptime: z.number(),
});

type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * GET /health
 *
 * Returns 200 when the API can reach Postgres, 503 otherwise.
 * Does NOT require authentication — used by Docker healthcheck and load
 * balancers.
 *
 * Response body:
 *   { "status": "ok"|"degraded", "postgres": "ok"|"error", "uptime": <seconds> }
 */
export function healthRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        response: {
          200: HealthResponseSchema,
          503: HealthResponseSchema,
        },
      },
    },
    async (_request, reply): Promise<HealthResponse> => {
      let postgresStatus: 'ok' | 'error' = 'error';
      try {
        const pool = getPool();
        await pool.query('SELECT 1');
        postgresStatus = 'ok';
      } catch {
        // Intentionally swallowed – degraded state is reflected in the body
      }

      const body: HealthResponse = {
        status: postgresStatus === 'ok' ? 'ok' : 'degraded',
        postgres: postgresStatus,
        uptime: process.uptime(),
      };

      const statusCode = postgresStatus === 'ok' ? 200 : 503;
      return reply.status(statusCode).send(body);
    },
  );
}

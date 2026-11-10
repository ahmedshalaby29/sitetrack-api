import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ErrorCode, errorEnvelope } from '../lib/errors.js';

/** Type guard: narrows unknown to FastifyError (statusCode + code on the error). */
function isFastifyError(err: unknown): err is FastifyError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    'code' in err
  );
}

/**
 * Registers a global error handler that always returns the error envelope:
 *   { "error": { "code": "...", "message": "..." } }
 *
 * No stack traces or internal details ever reach the client (rule 10).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    // Zod validation errors (from fastify-type-provider-zod)
    if (error instanceof ZodError) {
      const message = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      void reply
        .status(400)
        .send(errorEnvelope(ErrorCode.VALIDATION, message));
      return;
    }

    // Application domain errors
    if (error instanceof AppError) {
      void reply
        .status(error.statusCode)
        .send(errorEnvelope(error.code, error.message));
      return;
    }

    // Fastify's own errors (validation, 404, etc.)
    if (isFastifyError(error)) {
      // Schema-level validation errors
      if (error.validation != null) {
        void reply
          .status(400)
          .send(errorEnvelope(ErrorCode.VALIDATION, error.message));
        return;
      }

      // Fastify 404 (no matching route)
      if (error.statusCode === 404) {
        void reply
          .status(404)
          .send(errorEnvelope(ErrorCode.NOT_FOUND, 'Not found'));
        return;
      }
    }

    // Everything else: log the real error, return a generic 500
    app.log.error(error);
    void reply
      .status(500)
      .send(errorEnvelope(ErrorCode.INTERNAL, 'Internal server error'));
  });

  // Handle 404 for unmatched routes
  app.setNotFoundHandler((_request, reply) => {
    void reply
      .status(404)
      .send(errorEnvelope(ErrorCode.NOT_FOUND, 'Not found'));
  });
}

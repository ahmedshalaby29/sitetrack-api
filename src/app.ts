import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { healthRoutes } from './modules/health/routes.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
    },
  });

  // Use Zod for request validation and response serialisation
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Global error → error-envelope mapping (rule 10)
  registerErrorHandler(app);

  // Routes
  void app.register(healthRoutes);

  return app;
}

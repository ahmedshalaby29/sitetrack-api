import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { registerErrorHandler } from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import { healthRoutes } from './modules/health/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import { invitationRoutes } from './modules/invitations/routes.js';
import { memberRoutes } from './modules/members/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { materialRoutes } from './modules/materials/routes.js';

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

  // Plugins
  void app.register(authPlugin);

  // Routes
  void app.register(healthRoutes);
  void app.register(authRoutes);
  void app.register(userRoutes);
  void app.register(materialRoutes);
  void app.register(projectRoutes);
  void app.register(invitationRoutes);
  void app.register(memberRoutes);

  return app;
}

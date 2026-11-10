import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
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
import { taskRoutes } from './modules/tasks/routes.js';
import { stockRoutes } from './modules/stock/routes.js';
import { deliveryRoutes } from './modules/deliveries/routes.js';

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

  // Swagger OpenAPI documentation
  void app.register(swagger, {
    openapi: {
      info: {
        title: 'SiteTrack API',
        description:
          'SiteTrack construction project and materials tracker backend API with DAG task scheduling, stock tracking, and delivery logistics.',
        version: '0.1.0',
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Local development server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'JWT access token',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  void app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

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
  void app.register(taskRoutes);
  void app.register(stockRoutes);
  void app.register(deliveryRoutes);

  return app;
}

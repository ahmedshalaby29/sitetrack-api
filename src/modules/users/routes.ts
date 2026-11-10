import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireSuperAdmin } from '../../plugins/guards.js';
import {
  updateRoleBodySchema,
  updateRoleParamsSchema,
  userRoleResponseSchema,
} from './schemas.js';
import * as service from './service.js';

export function userRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().patch(
    '/users/:id/role',
    {
      preHandler: [requireSuperAdmin],
      schema: {
        params: updateRoleParamsSchema,
        body: updateRoleBodySchema,
        response: {
          200: userRoleResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await service.changeUserRole(
        request.params.id,
        request.body.role,
      );
      return reply.status(200).send({ user });
    },
  );
}

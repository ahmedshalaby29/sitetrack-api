import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '../../lib/db.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { projectGuard, requireProjectAdmin } from '../../plugins/guards.js';
import { MembersRepo } from './repo.js';
import {
  ProjectMemberListSchema,
  type ProjectMemberList,
} from './schemas.js';
import { MembersService } from './service.js';

const OkResponseSchema = z.object({
  status: z.literal('ok'),
});
type OkResponse = z.infer<typeof OkResponseSchema>;

export function memberRoutes(app: FastifyInstance): void {
  const repo = new MembersRepo(getPool());
  const service = new MembersService(repo);

  // 1. List project members (member / superAdmin)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/projects/:projectId/members',
    {
      preHandler: [projectGuard],
      schema: {
        response: {
          200: ProjectMemberListSchema,
        },
      },
    },
    async (request, reply): Promise<ProjectMemberList> => {
      if (!request.project) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }
      const list = await service.list(request.project.id);
      return reply.status(200).send(list);
    },
  );

  // 2. Promote member to admin (project admin only)
  app.withTypeProvider<ZodTypeProvider>().post(
    '/projects/:projectId/members/:userId/promote',
    {
      preHandler: [requireProjectAdmin],
      schema: {
        response: {
          200: OkResponseSchema,
        },
      },
    },
    async (request, reply): Promise<OkResponse> => {
      if (!request.project) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }
      const params = request.params as { userId?: string };
      const targetUserId = Number(params.userId);
      if (Number.isNaN(targetUserId) || targetUserId <= 0) {
        throw new AppError(404, ErrorCode.MEMBER_NOT_FOUND, 'Invalid user ID');
      }
      await service.promote(request.project.id, targetUserId);
      return reply.status(200).send({ status: 'ok' });
    },
  );

  // 3. Demote admin to regular member (project admin only; last admin rejected)
  app.withTypeProvider<ZodTypeProvider>().post(
    '/projects/:projectId/members/:userId/demote',
    {
      preHandler: [requireProjectAdmin],
      schema: {
        response: {
          200: OkResponseSchema,
        },
      },
    },
    async (request, reply): Promise<OkResponse> => {
      if (!request.project) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }
      const params = request.params as { userId?: string };
      const targetUserId = Number(params.userId);
      if (Number.isNaN(targetUserId) || targetUserId <= 0) {
        throw new AppError(404, ErrorCode.MEMBER_NOT_FOUND, 'Invalid user ID');
      }
      await service.demote(request.project.id, targetUserId);
      return reply.status(200).send({ status: 'ok' });
    },
  );

  // 4. Remove member or leave project (admin can remove anyone, member can remove self)
  app.withTypeProvider<ZodTypeProvider>().delete(
    '/projects/:projectId/members/:userId',
    {
      preHandler: [projectGuard],
      schema: {
        response: {
          200: OkResponseSchema,
        },
      },
    },
    async (request, reply): Promise<OkResponse> => {
      if (!request.project || !request.auth) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }
      const params = request.params as { userId?: string };
      const targetUserId = Number(params.userId);
      if (Number.isNaN(targetUserId) || targetUserId <= 0) {
        throw new AppError(404, ErrorCode.MEMBER_NOT_FOUND, 'Invalid user ID');
      }

      await service.remove(
        request.project.id,
        request.auth.userId,
        targetUserId,
        request.project.isAdmin,
      );
      return reply.status(200).send({ status: 'ok' });
    },
  );
}

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '../../lib/db.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { projectGuard, requireProjectAdmin } from '../../plugins/guards.js';
import { InvitationsRepo } from './repo.js';
import {
  CreateInvitationSchema,
  InvitationResponseSchema,
  NotificationListResponseSchema,
  type InvitationResponse,
  type NotificationListResponse,
} from './schemas.js';
import { InvitationsService } from './service.js';

const OkResponseSchema = z.object({
  status: z.literal('ok'),
});
type OkResponse = z.infer<typeof OkResponseSchema>;

export function invitationRoutes(app: FastifyInstance): void {
  const repo = new InvitationsRepo(getPool());
  const service = new InvitationsService(repo);

  // ── Project-level invitations ─────────────────────────────────────────────

  // 1. Invite user by email (project admin only)
  app.withTypeProvider<ZodTypeProvider>().post(
    '/projects/:projectId/invitations',
    {
      preHandler: [requireProjectAdmin],
      schema: {
        body: CreateInvitationSchema,
        response: {
          201: InvitationResponseSchema,
        },
      },
    },
    async (request, reply): Promise<InvitationResponse> => {
      if (!request.project || !request.auth) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }
      const inv = await service.create(
        request.project.id,
        request.auth.userId,
        request.body,
      );
      return reply.status(201).send(inv);
    },
  );

  // 2. List pending project invitations (member/admin)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/projects/:projectId/invitations',
    {
      preHandler: [projectGuard],
      schema: {
        response: {
          200: z.array(InvitationResponseSchema),
        },
      },
    },
    async (request, reply): Promise<InvitationResponse[]> => {
      if (!request.project) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }
      const list = await service.listProjectInvitations(request.project.id);
      return reply.status(200).send(list);
    },
  );

  // 3. Withdraw pending invitation (project admin only)
  app.withTypeProvider<ZodTypeProvider>().delete(
    '/projects/:projectId/invitations/:invitationId',
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
      const params = request.params as { invitationId?: string };
      const invId = Number(params.invitationId);
      if (Number.isNaN(invId) || invId <= 0) {
        throw new AppError(
          404,
          ErrorCode.INVITATION_NOT_FOUND,
          'Invalid invitation ID',
        );
      }
      await service.withdraw(request.project.id, invId);
      return reply.status(200).send({ status: 'ok' });
    },
  );

  // ── User-level notifications ──────────────────────────────────────────────

  // 4. List notifications newest first (Decision 9)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/notifications',
    {
      preHandler: [app.authenticate],
      schema: {
        response: {
          200: NotificationListResponseSchema,
        },
      },
    },
    async (request, reply): Promise<NotificationListResponse> => {
      if (!request.auth) {
        throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
      }
      const result = await service.listUserNotifications(request.auth.userId);
      return reply.status(200).send(result);
    },
  );

  // 5. Accept invitation
  app.withTypeProvider<ZodTypeProvider>().post(
    '/notifications/:invitationId/accept',
    {
      preHandler: [app.authenticate],
      schema: {
        response: {
          200: InvitationResponseSchema,
        },
      },
    },
    async (request, reply): Promise<InvitationResponse> => {
      if (!request.auth) {
        throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
      }
      const params = request.params as { invitationId?: string };
      const invId = Number(params.invitationId);
      if (Number.isNaN(invId) || invId <= 0) {
        throw new AppError(
          404,
          ErrorCode.INVITATION_NOT_FOUND,
          'Invalid invitation ID',
        );
      }
      const accepted = await service.accept(invId, request.auth.userId);
      return reply.status(200).send(accepted);
    },
  );

  // 6. Reject invitation
  app.withTypeProvider<ZodTypeProvider>().post(
    '/notifications/:invitationId/reject',
    {
      preHandler: [app.authenticate],
      schema: {
        response: {
          200: InvitationResponseSchema,
        },
      },
    },
    async (request, reply): Promise<InvitationResponse> => {
      if (!request.auth) {
        throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
      }
      const params = request.params as { invitationId?: string };
      const invId = Number(params.invitationId);
      if (Number.isNaN(invId) || invId <= 0) {
        throw new AppError(
          404,
          ErrorCode.INVITATION_NOT_FOUND,
          'Invalid invitation ID',
        );
      }
      const rejected = await service.reject(invId, request.auth.userId);
      return reply.status(200).send(rejected);
    },
  );

  // 7. Explicit mark-read endpoint
  app.withTypeProvider<ZodTypeProvider>().patch(
    '/notifications/:invitationId/read',
    {
      preHandler: [app.authenticate],
      schema: {
        response: {
          200: OkResponseSchema,
        },
      },
    },
    async (request, reply): Promise<OkResponse> => {
      if (!request.auth) {
        throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
      }
      const params = request.params as { invitationId?: string };
      const invId = Number(params.invitationId);
      if (Number.isNaN(invId) || invId <= 0) {
        throw new AppError(
          404,
          ErrorCode.INVITATION_NOT_FOUND,
          'Invalid invitation ID',
        );
      }
      await service.markAsRead(invId, request.auth.userId);
      return reply.status(200).send({ status: 'ok' });
    },
  );
}

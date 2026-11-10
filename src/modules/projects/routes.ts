import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '../../lib/db.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { projectGuard, requireProjectAdmin } from '../../plugins/guards.js';
import { ProjectsRepo } from './repo.js';
import {
  CreateProjectSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  UpdateProjectSchema,
  type ProjectListResponse,
  type ProjectResponse,
} from './schemas.js';
import { ProjectsService } from './service.js';

const OkResponseSchema = z.object({
  status: z.literal('ok'),
});
type OkResponse = z.infer<typeof OkResponseSchema>;

export function projectRoutes(app: FastifyInstance): void {
  const repo = new ProjectsRepo(getPool());
  const service = new ProjectsService(repo);

  // 1. Create project
  app.withTypeProvider<ZodTypeProvider>().post(
    '/projects',
    {
      preHandler: [app.authenticate],
      schema: {
        body: CreateProjectSchema,
        response: {
          201: ProjectResponseSchema,
        },
      },
    },
    async (request, reply): Promise<ProjectResponse> => {
      if (!request.auth) {
        throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
      }
      const project = await service.create(request.auth.userId, request.body);
      return reply.status(201).send(project);
    },
  );

  // 2. List accessible projects
  app.withTypeProvider<ZodTypeProvider>().get(
    '/projects',
    {
      preHandler: [app.authenticate],
      schema: {
        response: {
          200: ProjectListResponseSchema,
        },
      },
    },
    async (request, reply): Promise<ProjectListResponse> => {
      if (!request.auth) {
        throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
      }
      const isSuperAdmin = request.auth.appRole === 'super_admin';
      const result = await service.list(request.auth.userId, isSuperAdmin);
      return reply.status(200).send(result);
    },
  );

  // 3. Get project details (guarded: 404 for non-members)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/projects/:projectId',
    {
      preHandler: [projectGuard],
      schema: {
        response: {
          200: ProjectResponseSchema,
        },
      },
    },
    async (request, reply): Promise<ProjectResponse> => {
      if (!request.project || !request.auth) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }
      const project = await service.getById(
        request.project.id,
        request.auth.userId,
      );
      return reply.status(200).send(project);
    },
  );

  // 4. Update project (admin only: 404 non-members, 403 non-admin members)
  app.withTypeProvider<ZodTypeProvider>().patch(
    '/projects/:projectId',
    {
      preHandler: [requireProjectAdmin],
      schema: {
        body: UpdateProjectSchema,
        response: {
          200: ProjectResponseSchema,
        },
      },
    },
    async (request, reply): Promise<ProjectResponse> => {
      if (!request.project || !request.auth) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }
      const updated = await service.update(
        request.project.id,
        request.auth.userId,
        request.body,
      );
      return reply.status(200).send(updated);
    },
  );

  // 5. Delete project (soft delete, admin only)
  app.withTypeProvider<ZodTypeProvider>().delete(
    '/projects/:projectId',
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
      await service.delete(request.project.id);
      return reply.status(200).send({ status: 'ok' });
    },
  );
}

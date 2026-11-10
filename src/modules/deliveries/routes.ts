import type { FastifyInstance } from 'fastify';
import { getPool } from '../../lib/db.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { parseProjectId } from '../../lib/ids.js';
import { projectGuard, requireStoreManager } from '../../plugins/guards.js';
import { DeliveriesRepo } from './repo.js';
import {
  companyInitiateDeliveryBodySchema,
  deliveryParamSchema,
  projectInitiateDeliveryBodySchema,
  singleDeliveryResponseSchema,
  type CompanyInitiateDeliveryBody,
  type DeliveryParam,
  type ProjectInitiateDeliveryBody,
} from './schemas.js';
import { DeliveriesService } from './service.js';

function parseTargetProjectId(raw: string | number): number {
  if (typeof raw === 'number') {
    if (raw <= 0) throw new AppError(400, ErrorCode.VALIDATION, 'Invalid project ID');
    return raw;
  }
  const parsed = parseProjectId(raw);
  if (parsed !== null) return parsed;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && asNum > 0) return asNum;
  throw new AppError(400, ErrorCode.VALIDATION, 'Invalid project ID format');
}

export function deliveryRoutes(app: FastifyInstance): void {
  const pool = getPool();
  const repo = new DeliveriesRepo(pool);
  const service = new DeliveriesService(repo);

  // ── Project deliveries: /projects/:projectId/deliveries ──────────────────
  void app.register((projectScoped): void => {
    projectScoped.addHook('preHandler', projectGuard);

    // POST /projects/:projectId/deliveries (Initiate from project, or to_project if store manager)
    projectScoped.post<{
      Params: { projectId: string };
      Body: ProjectInitiateDeliveryBody;
    }>(
      '/projects/:projectId/deliveries',
      {
        schema: {
          params: deliveryParamSchema.pick({ projectId: true }),
          body: projectInitiateDeliveryBodySchema,
          response: { 201: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const projectId = request.project?.id;
        const userId = request.auth?.userId;
        const userRole = request.auth?.appRole;

        if (!projectId) {
          throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
        }
        if (!userId) {
          throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
        }

        const direction = request.body.direction;
        if (direction === 'to_project' && userRole !== 'store_manager' && userRole !== 'super_admin') {
          throw new AppError(403, ErrorCode.FORBIDDEN_ROLE, 'Only store managers can initiate deliveries to projects');
        }

        const delivery = await service.initiateDelivery({
          projectId,
          direction,
          senderUserId: userId,
          lines: request.body.lines.map((l) => ({
            materialId: l.materialId,
            quantity: l.quantity,
          })),
        });

        return reply.status(201).send({ delivery });
      },
    );

    // GET /projects/:projectId/deliveries/:deliveryId
    projectScoped.get<{
      Params: DeliveryParam;
    }>(
      '/projects/:projectId/deliveries/:deliveryId',
      {
        schema: {
          params: deliveryParamSchema,
          response: { 200: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const projectId = request.project?.id;
        if (!projectId) {
          throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
        }
        const delivery = await service.getDelivery(request.params.deliveryId, projectId);
        return reply.status(200).send({ delivery });
      },
    );

    // POST /projects/:projectId/deliveries/:deliveryId/record (Project records to_project receipt)
    projectScoped.post<{
      Params: DeliveryParam;
    }>(
      '/projects/:projectId/deliveries/:deliveryId/record',
      {
        schema: {
          params: deliveryParamSchema,
          response: { 200: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const projectId = request.project?.id;
        const userId = request.auth?.userId;
        if (!projectId) {
          throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
        }
        if (!userId) {
          throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
        }

        const delivery = await service.recordDelivery({
          deliveryId: request.params.deliveryId,
          receiverUserId: userId,
          expectedProjectId: projectId,
          isStoreManager: false,
        });
        return reply.status(200).send({ delivery });
      },
    );

    // POST /projects/:projectId/deliveries/:deliveryId/reject (Project rejects to_project receipt)
    projectScoped.post<{
      Params: DeliveryParam;
    }>(
      '/projects/:projectId/deliveries/:deliveryId/reject',
      {
        schema: {
          params: deliveryParamSchema,
          response: { 200: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const projectId = request.project?.id;
        const userId = request.auth?.userId;
        if (!projectId) {
          throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
        }
        if (!userId) {
          throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
        }

        const delivery = await service.rejectDelivery({
          deliveryId: request.params.deliveryId,
          receiverUserId: userId,
          expectedProjectId: projectId,
          isStoreManager: false,
        });
        return reply.status(200).send({ delivery });
      },
    );

    // POST /projects/:projectId/deliveries/:deliveryId/cancel (Project cancels to_company return)
    projectScoped.post<{
      Params: DeliveryParam;
    }>(
      '/projects/:projectId/deliveries/:deliveryId/cancel',
      {
        schema: {
          params: deliveryParamSchema,
          response: { 200: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const projectId = request.project?.id;
        const userId = request.auth?.userId;
        if (!projectId) {
          throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
        }
        if (!userId) {
          throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
        }

        const delivery = await service.cancelDelivery({
          deliveryId: request.params.deliveryId,
          senderUserId: userId,
          expectedProjectId: projectId,
          isStoreManager: false,
        });
        return reply.status(200).send({ delivery });
      },
    );
  });

  // ── Company store deliveries: /company-store/deliveries ──────────────────
  void app.register((companyScoped): void => {
    companyScoped.addHook('preHandler', requireStoreManager);

    // POST /company-store/deliveries (Initiate to_project delivery)
    companyScoped.post<{
      Body: CompanyInitiateDeliveryBody;
    }>(
      '/company-store/deliveries',
      {
        schema: {
          body: companyInitiateDeliveryBodySchema,
          response: { 201: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
        }

        const projectId = parseTargetProjectId(request.body.projectId);

        const delivery = await service.initiateDelivery({
          projectId,
          direction: 'to_project',
          senderUserId: userId,
          lines: request.body.lines.map((l) => ({
            materialId: l.materialId,
            quantity: l.quantity,
          })),
        });

        return reply.status(201).send({ delivery });
      },
    );

    // GET /company-store/deliveries/:deliveryId
    companyScoped.get<{
      Params: { deliveryId: number };
    }>(
      '/company-store/deliveries/:deliveryId',
      {
        schema: {
          params: deliveryParamSchema.pick({ deliveryId: true }),
          response: { 200: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const delivery = await service.getDelivery(request.params.deliveryId);
        return reply.status(200).send({ delivery });
      },
    );

    // POST /company-store/deliveries/:deliveryId/record (Company records to_company return receipt)
    companyScoped.post<{
      Params: { deliveryId: number };
    }>(
      '/company-store/deliveries/:deliveryId/record',
      {
        schema: {
          params: deliveryParamSchema.pick({ deliveryId: true }),
          response: { 200: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
        }

        const delivery = await service.recordDelivery({
          deliveryId: request.params.deliveryId,
          receiverUserId: userId,
          isStoreManager: true,
        });
        return reply.status(200).send({ delivery });
      },
    );

    // POST /company-store/deliveries/:deliveryId/reject (Company rejects to_company return receipt)
    companyScoped.post<{
      Params: { deliveryId: number };
    }>(
      '/company-store/deliveries/:deliveryId/reject',
      {
        schema: {
          params: deliveryParamSchema.pick({ deliveryId: true }),
          response: { 200: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
        }

        const delivery = await service.rejectDelivery({
          deliveryId: request.params.deliveryId,
          receiverUserId: userId,
          isStoreManager: true,
        });
        return reply.status(200).send({ delivery });
      },
    );

    // POST /company-store/deliveries/:deliveryId/cancel (Company cancels to_project delivery)
    companyScoped.post<{
      Params: { deliveryId: number };
    }>(
      '/company-store/deliveries/:deliveryId/cancel',
      {
        schema: {
          params: deliveryParamSchema.pick({ deliveryId: true }),
          response: { 200: singleDeliveryResponseSchema },
        },
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
        }

        const delivery = await service.cancelDelivery({
          deliveryId: request.params.deliveryId,
          senderUserId: userId,
          isStoreManager: true,
        });
        return reply.status(200).send({ delivery });
      },
    );
  });
};

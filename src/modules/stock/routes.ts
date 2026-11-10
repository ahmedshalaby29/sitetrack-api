import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { projectGuard, requireStoreManager } from '../../plugins/guards.js';
import {
  addStockBodySchema,
  companyStockListResponseSchema,
  listCompanyStockQuerySchema,
  listProjectStoreQuerySchema,
  materialParamSchema,
  projectStoreParamsSchema,
  projectStoreResponseSchema,
  setReorderPointBodySchema,
  singleStockResponseSchema,
} from './schemas.js';
import { StockService } from './service.js';

export function stockRoutes(app: FastifyInstance): void {
  const service = new StockService();

  // 1. Screen 10: Company store stock list (store_manager / super_admin only)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/company-store/stock',
    {
      preHandler: [requireStoreManager],
      schema: {
        querystring: listCompanyStockQuerySchema,
        response: {
          200: companyStockListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.listCompanyStock(request.query);
      return reply.status(200).send(result);
    },
  );

  // 2. Add stock to company store (store_manager / super_admin only)
  app.withTypeProvider<ZodTypeProvider>().post(
    '/company-store/stock/add',
    {
      preHandler: [requireStoreManager],
      schema: {
        body: addStockBodySchema,
        response: {
          200: singleStockResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.addStock(
        request.body.materialId,
        request.body.quantity,
      );
      return reply.status(200).send(result);
    },
  );

  // Alias: POST /company-store/stock
  app.withTypeProvider<ZodTypeProvider>().post(
    '/company-store/stock',
    {
      preHandler: [requireStoreManager],
      schema: {
        body: addStockBodySchema,
        response: {
          200: singleStockResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.addStock(
        request.body.materialId,
        request.body.quantity,
      );
      return reply.status(200).send(result);
    },
  );

  // 3. Set reorder point in company store (store_manager / super_admin only)
  app.withTypeProvider<ZodTypeProvider>().patch(
    '/company-store/stock/:materialId/reorder-point',
    {
      preHandler: [requireStoreManager],
      schema: {
        params: materialParamSchema,
        body: setReorderPointBodySchema,
        response: {
          200: singleStockResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.setReorderPoint(
        request.params.materialId,
        request.body.reorderPoint,
      );
      return reply.status(200).send(result);
    },
  );

  // Alias: PATCH /company-store/stock/:materialId
  app.withTypeProvider<ZodTypeProvider>().patch(
    '/company-store/stock/:materialId',
    {
      preHandler: [requireStoreManager],
      schema: {
        params: materialParamSchema,
        body: setReorderPointBodySchema,
        response: {
          200: singleStockResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.setReorderPoint(
        request.params.materialId,
        request.body.reorderPoint,
      );
      return reply.status(200).send(result);
    },
  );

  // 4. Screen 7: Project store stock list (project members & super_admin)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/projects/:projectId/store',
    {
      preHandler: [projectGuard],
      schema: {
        params: projectStoreParamsSchema,
        querystring: listProjectStoreQuerySchema,
        response: {
          200: projectStoreResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const projectId = request.project?.id;
      if (!projectId) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const result = await service.listProjectStore(projectId, request.query);
      return reply.status(200).send(result);
    },
  );
}

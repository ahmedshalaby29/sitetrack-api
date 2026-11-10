import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireStoreManager } from '../../plugins/guards.js';
import {
  createMaterialBodySchema,
  listMaterialsQuerySchema,
  materialListResponseSchema,
  materialParamsSchema,
  singleMaterialResponseSchema,
} from './schemas.js';
import { MaterialsService } from './service.js';

export function materialRoutes(app: FastifyInstance): void {
  const service = new MaterialsService();

  // 1. Create material (store manager or super admin only - Decision 4)
  app.withTypeProvider<ZodTypeProvider>().post(
    '/materials',
    {
      preHandler: [requireStoreManager],
      schema: {
        body: createMaterialBodySchema,
        response: {
          201: singleMaterialResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const material = await service.createMaterial(request.body);
      return reply.status(201).send({ material });
    },
  );

  // 2. List materials (authenticated callers, supports search and category filter)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/materials',
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: listMaterialsQuerySchema,
        response: {
          200: materialListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.listMaterials(request.query);
      return reply.status(200).send(result);
    },
  );

  // 3. Get single material by ID
  app.withTypeProvider<ZodTypeProvider>().get(
    '/materials/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        params: materialParamsSchema,
        response: {
          200: singleMaterialResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const material = await service.getMaterial(request.params.id);
      return reply.status(200).send({ material });
    },
  );
}

import { z } from 'zod';

export const createMaterialBodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  category: z.string().trim().min(1, 'Category is required').max(100),
  unit: z.string().trim().min(1, 'Unit is required').max(50),
});

export type CreateMaterialBody = z.infer<typeof createMaterialBodySchema>;

export const materialParamsSchema = z.object({
  id: z.coerce.number().int().positive({ message: 'Material ID must be a positive integer' }),
});

export type MaterialParams = z.infer<typeof materialParamsSchema>;

export const listMaterialsQuerySchema = z.object({
  search: z.string().trim().optional(),
  category: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListMaterialsQuery = z.infer<typeof listMaterialsQuerySchema>;

export const materialResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  category: z.string(),
  unit: z.string(),
  createdAt: z.string(),
});

export type MaterialResponse = z.infer<typeof materialResponseSchema>;

export const singleMaterialResponseSchema = z.object({
  material: materialResponseSchema,
});

export const materialListResponseSchema = z.object({
  materials: z.array(materialResponseSchema),
  total: z.number(),
});

import { z } from 'zod';

export const quantityInputSchema = z
  .union([z.string(), z.number()])
  .transform((val) => (typeof val === 'number' ? val.toFixed(3) : val.trim()))
  .refine(
    (val) => /^\d+(\.\d{1,3})?$/.test(val) && Number.parseFloat(val) > 0,
    { message: 'Quantity must be a positive number with up to 3 decimal places' },
  );

export const reorderPointInputSchema = z
  .union([z.string(), z.number()])
  .transform((val) => (typeof val === 'number' ? val.toFixed(3) : val.trim()))
  .refine(
    (val) => /^\d+(\.\d{1,3})?$/.test(val) && Number.parseFloat(val) >= 0,
    { message: 'Reorder point must be a non-negative number with up to 3 decimal places' },
  );

export const addStockBodySchema = z.object({
  materialId: z.coerce.number().int().positive({ message: 'Material ID must be a positive integer' }),
  quantity: quantityInputSchema,
});
export type AddStockBody = z.infer<typeof addStockBodySchema>;

export const setReorderPointBodySchema = z.object({
  reorderPoint: reorderPointInputSchema,
});
export type SetReorderPointBody = z.infer<typeof setReorderPointBodySchema>;

export const materialParamSchema = z.object({
  materialId: z.coerce.number().int().positive(),
});
export type MaterialParam = z.infer<typeof materialParamSchema>;

export const projectStoreParamsSchema = z.object({
  projectId: z.string(),
});
export type ProjectStoreParams = z.infer<typeof projectStoreParamsSchema>;

export const StockStatusSchema = z.enum(['available', 'low_stock', 'out_of_stock']);
export type StockStatus = z.infer<typeof StockStatusSchema>;

export const listCompanyStockQuerySchema = z.object({
  search: z.string().trim().optional(),
  category: z.string().trim().optional(),
  status: StockStatusSchema.optional(),
  sort: z.enum(['name', 'quantity', 'status']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListCompanyStockQuery = z.infer<typeof listCompanyStockQuerySchema>;

export const companyStockItemSchema = z.object({
  materialId: z.number(),
  name: z.string(),
  category: z.string(),
  unit: z.string(),
  quantity: z.string(),
  reorderPoint: z.string(),
  status: StockStatusSchema,
  inTransitToProjects: z.string(),
  lastDeliveryAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type CompanyStockItem = z.infer<typeof companyStockItemSchema>;

export const companyStockListResponseSchema = z.object({
  stock: z.array(companyStockItemSchema),
  total: z.number(),
});
export type CompanyStockListResponse = z.infer<typeof companyStockListResponseSchema>;

export const listProjectStoreQuerySchema = z.object({
  search: z.string().trim().optional(),
  category: z.string().trim().optional(),
  sort: z.enum(['name', 'quantity', 'last_delivery']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProjectStoreQuery = z.infer<typeof listProjectStoreQuerySchema>;

export const projectStockItemSchema = z.object({
  materialId: z.number(),
  name: z.string(),
  category: z.string(),
  unit: z.string(),
  quantity: z.string(),
  lastDeliveryAt: z.string().nullable(),
});
export type ProjectStockItem = z.infer<typeof projectStockItemSchema>;

export const projectStoreResponseSchema = z.object({
  stock: z.array(projectStockItemSchema),
  total: z.number(),
});
export type ProjectStoreResponse = z.infer<typeof projectStoreResponseSchema>;

export const singleStockResponseSchema = z.object({
  stock: z.object({
    storeId: z.number(),
    materialId: z.number(),
    quantity: z.string(),
    reorderPoint: z.string(),
    status: StockStatusSchema,
    lastDeliveryAt: z.string().nullable(),
    updatedAt: z.string(),
  }),
});
export type SingleStockResponse = z.infer<typeof singleStockResponseSchema>;

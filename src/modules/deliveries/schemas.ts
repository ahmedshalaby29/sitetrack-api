import { z } from 'zod';
import { quantityInputSchema } from '../stock/schemas.js';

export const deliveryDirectionSchema = z.enum(['to_project', 'to_company']);
export type DeliveryDirection = z.infer<typeof deliveryDirectionSchema>;

export const deliveryStatusSchema = z.enum(['in_transit', 'delivered', 'rejected', 'cancelled']);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const deliveryLineInputSchema = z.object({
  materialId: z.coerce.number().int().positive({ message: 'materialId must be a positive integer' }),
  quantity: quantityInputSchema,
});
export type DeliveryLineInput = z.infer<typeof deliveryLineInputSchema>;

export const initiateDeliveryBodySchema = z.object({
  projectId: z.union([z.string(), z.number()]).optional(),
  direction: deliveryDirectionSchema.optional(),
  lines: z.array(deliveryLineInputSchema).min(1, { message: 'At least one delivery line is required' }),
});
export type InitiateDeliveryBody = z.infer<typeof initiateDeliveryBodySchema>;

export const projectInitiateDeliveryBodySchema = z.object({
  direction: deliveryDirectionSchema.optional().default('to_company'),
  lines: z.array(deliveryLineInputSchema).min(1, { message: 'At least one delivery line is required' }),
});
export type ProjectInitiateDeliveryBody = z.infer<typeof projectInitiateDeliveryBodySchema>;

export const companyInitiateDeliveryBodySchema = z.object({
  projectId: z.union([z.string(), z.number()]),
  lines: z.array(deliveryLineInputSchema).min(1, { message: 'At least one delivery line is required' }),
});
export type CompanyInitiateDeliveryBody = z.infer<typeof companyInitiateDeliveryBodySchema>;

export const deliveryParamSchema = z.object({
  projectId: z.string().optional(),
  deliveryId: z.coerce.number().int().positive({ message: 'deliveryId must be a positive integer' }),
});
export type DeliveryParam = z.infer<typeof deliveryParamSchema>;

export const deliveryLineResponseSchema = z.object({
  materialId: z.number(),
  materialName: z.string(),
  category: z.string(),
  unit: z.string(),
  quantity: z.string(),
});
export type DeliveryLineResponse = z.infer<typeof deliveryLineResponseSchema>;

export const deliveryResponseSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  formattedProjectId: z.string(),
  direction: deliveryDirectionSchema,
  status: deliveryStatusSchema,
  senderUserId: z.number(),
  senderName: z.string(),
  receiverUserId: z.number().nullable(),
  receiverName: z.string().nullable(),
  sentAt: z.string(),
  receivedAt: z.string().nullable(),
  createdAt: z.string(),
  lines: z.array(deliveryLineResponseSchema),
});
export type DeliveryResponse = z.infer<typeof deliveryResponseSchema>;

export const singleDeliveryResponseSchema = z.object({
  delivery: deliveryResponseSchema,
});
export type SingleDeliveryResponse = z.infer<typeof singleDeliveryResponseSchema>;

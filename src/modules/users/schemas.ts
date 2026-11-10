import { z } from 'zod';

export const updateRoleParamsSchema = z.object({
  id: z.coerce.number().int().positive({ message: 'User ID must be a positive integer' }),
});

export type UpdateRoleParams = z.infer<typeof updateRoleParamsSchema>;

export const updateRoleBodySchema = z.object({
  role: z.enum(['user', 'store_manager', 'super_admin'], {
    errorMap: () => ({ message: "Role must be 'user', 'store_manager', or 'super_admin'" }),
  }),
});

export type UpdateRoleBody = z.infer<typeof updateRoleBodySchema>;

export const userRoleResponseSchema = z.object({
  user: z.object({
    id: z.number(),
    name: z.string(),
    email: z.string(),
    appRole: z.enum(['user', 'store_manager', 'super_admin']),
    createdAt: z.string(),
  }),
});

export type UserRoleResponse = z.infer<typeof userRoleResponseSchema>;

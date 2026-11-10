import { z } from 'zod';

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required'),
  description: z.string().trim().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be YYYY-MM-DD')
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'End date must be YYYY-MM-DD')
    .optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').optional(),
  description: z.string().trim().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be YYYY-MM-DD')
    .nullable()
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'End date must be YYYY-MM-DD')
    .nullable()
    .optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

export const ProjectResponseSchema = z.object({
  id: z.string(), // Formatted PRJ-XXXX
  name: z.string(),
  description: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  amIAdmin: z.boolean(),
  memberCount: z.number(),
  storeId: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectResponseSchema),
  total: z.number(),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

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

export const TaskCountsSchema = z.object({
  total: z.number(),
  notStarted: z.number(),
  inProgress: z.number(),
  blocked: z.number(),
  done: z.number(),
});
export type TaskCounts = z.infer<typeof TaskCountsSchema>;

export const ProjectResponseSchema = z.object({
  id: z.string(), // Formatted PRJ-XXXX
  name: z.string(),
  description: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  amIAdmin: z.boolean(),
  memberCount: z.number(),
  storeId: z.number().optional(),
  taskCounts: TaskCountsSchema.optional().default({
    total: 0,
    notStarted: 0,
    inProgress: 0,
    blocked: 0,
    done: 0,
  }),
  percentDone: z.number().optional().default(0),
  lateCount: z.number().optional().default(0),
  blockedCount: z.number().optional().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const ListProjectsQuerySchema = z.object({
  search: z.string().trim().optional(),
  hasLate: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((val) => val === true || val === 'true')
    .optional(),
  sort: z.enum(['name', 'start_date', 'percent_done', 'late_tasks', 'id']).optional().default('id'),
  order: z.enum(['asc', 'desc']).optional().default('asc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;

export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectResponseSchema),
  total: z.number(),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

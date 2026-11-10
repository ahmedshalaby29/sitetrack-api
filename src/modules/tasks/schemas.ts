import { z } from 'zod';

export const TaskStatusSchema = z.enum(['not_started', 'in_progress', 'done']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const createTaskBodySchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    description: z.string().trim().default(''),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'End date must be YYYY-MM-DD'),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
  });

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

export const updateTaskBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return data.endDate >= data.startDate;
      }
      return true;
    },
    {
      message: 'End date must be on or after start date',
      path: ['endDate'],
    },
  );

export type UpdateTaskBody = z.infer<typeof updateTaskBodySchema>;

export const taskParamsSchema = z.object({
  projectId: z.string(),
  taskId: z.string(),
});

export type TaskParams = z.infer<typeof taskParamsSchema>;

export const listTasksQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
  late: z.coerce.boolean().optional(),
  blocked: z.coerce.boolean().optional(),
  search: z.string().trim().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(['id', 'name', 'start', 'end', 'status']).default('id'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const TaskResponseSchema = z.object({
  id: z.string(),
  number: z.number(),
  projectId: z.string(),
  name: z.string(),
  description: z.string(),
  status: TaskStatusSchema,
  blocked: z.boolean(),
  late: z.boolean(),
  startDate: z.string(),
  endDate: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TaskResponse = z.infer<typeof TaskResponseSchema>;

export const SingleTaskResponseSchema = z.object({
  task: TaskResponseSchema,
});

export const TaskListResponseSchema = z.object({
  tasks: z.array(TaskResponseSchema),
  total: z.number(),
});

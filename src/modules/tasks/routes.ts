import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { parseTaskId } from '../../lib/ids.js';
import { projectGuard } from '../../plugins/guards.js';
import {
  createTaskBodySchema,
  listTasksQuerySchema,
  SingleTaskResponseSchema,
  TaskListResponseSchema,
  taskParamsSchema,
  updateTaskBodySchema,
} from './schemas.js';
import { TasksService } from './service.js';

function parseTaskParam(rawTaskId: string, currentProjectId: number): number {
  if (rawTaskId.startsWith('PRJ-')) {
    const parsed = parseTaskId(rawTaskId);
    // Rule 3: A valid id under the wrong project returns 404
    if (parsed?.projectId !== currentProjectId) {
      throw new AppError(404, ErrorCode.TASK_NOT_FOUND, 'Task not found');
    }
    return parsed.taskNumber;
  }
  const num = Number.parseInt(rawTaskId, 10);
  if (Number.isNaN(num) || num <= 0) {
    throw new AppError(404, ErrorCode.TASK_NOT_FOUND, 'Task not found');
  }
  return num;
}

export function taskRoutes(app: FastifyInstance): void {
  const service = new TasksService();
  // 1. Create task in project
  app.withTypeProvider<ZodTypeProvider>().post(
    '/projects/:projectId/tasks',
    {
      preHandler: [projectGuard],
      schema: {
        body: createTaskBodySchema,
        response: {
          201: SingleTaskResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const projectId = request.project?.id;
      if (!projectId) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const task = await service.createTask(projectId, request.body);
      return reply.status(201).send({ task });
    },
  );

  // 2. List tasks in project
  app.withTypeProvider<ZodTypeProvider>().get(
    '/projects/:projectId/tasks',
    {
      preHandler: [projectGuard],
      schema: {
        querystring: listTasksQuerySchema,
        response: {
          200: TaskListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const projectId = request.project?.id;
      if (!projectId) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const result = await service.listTasks(projectId, request.query);
      return reply.status(200).send(result);
    },
  );

  // 3. Get single task by ID
  app.withTypeProvider<ZodTypeProvider>().get(
    '/projects/:projectId/tasks/:taskId',
    {
      preHandler: [projectGuard],
      schema: {
        params: taskParamsSchema,
        response: {
          200: SingleTaskResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const projectId = request.project?.id;
      if (!projectId) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const taskNumber = parseTaskParam(request.params.taskId, projectId);
      const task = await service.getTask(projectId, taskNumber);
      return reply.status(200).send({ task });
    },
  );

  // 4. Update task metadata
  app.withTypeProvider<ZodTypeProvider>().patch(
    '/projects/:projectId/tasks/:taskId',
    {
      preHandler: [projectGuard],
      schema: {
        params: taskParamsSchema,
        body: updateTaskBodySchema,
        response: {
          200: SingleTaskResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const projectId = request.project?.id;
      if (!projectId) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const taskNumber = parseTaskParam(request.params.taskId, projectId);
      const task = await service.updateTask(projectId, taskNumber, request.body);
      return reply.status(200).send({ task });
    },
  );

  // 5. Delete task
  app.withTypeProvider<ZodTypeProvider>().delete(
    '/projects/:projectId/tasks/:taskId',
    {
      preHandler: [projectGuard],
      schema: {
        params: taskParamsSchema,
        response: {
          200: z.object({ status: z.literal('ok') }),
        },
      },
    },
    async (request, reply) => {
      const projectId = request.project?.id;
      if (!projectId) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const taskNumber = parseTaskParam(request.params.taskId, projectId);
      await service.deleteTask(projectId, taskNumber);
      return reply.status(200).send({ status: 'ok' });
    },
  );
}

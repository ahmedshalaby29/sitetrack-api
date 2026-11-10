import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { parseTaskId } from '../../lib/ids.js';
import { projectGuard } from '../../plugins/guards.js';
import {
  addDependencyBodySchema,
  createTaskBodySchema,
  dependencyParamsSchema,
  listTasksQuerySchema,
  singleDependencyResponseSchema,
  SingleTaskResponseSchema,
  taskDependenciesResponseSchema,
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

function parseDependsOn(val: string | number, currentProjectId: number): number {
  if (typeof val === 'number') {
    return val;
  }
  return parseTaskParam(val, currentProjectId);
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

  // 6. Add dependency edge (task depends on dependsOn)
  app.withTypeProvider<ZodTypeProvider>().post(
    '/projects/:projectId/tasks/:taskId/dependencies',
    {
      preHandler: [projectGuard],
      schema: {
        params: taskParamsSchema,
        body: addDependencyBodySchema,
        response: {
          201: singleDependencyResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const projectId = request.project?.id;
      if (!projectId) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const taskNumber = parseTaskParam(request.params.taskId, projectId);
      const dependsOnNumber = parseDependsOn(request.body.dependsOn, projectId);

      const dependency = await service.addDependency(
        projectId,
        taskNumber,
        dependsOnNumber,
      );
      return reply.status(201).send({ dependency });
    },
  );

  // 7. Remove dependency edge
  app.withTypeProvider<ZodTypeProvider>().delete(
    '/projects/:projectId/tasks/:taskId/dependencies/:dependsOnTaskId',
    {
      preHandler: [projectGuard],
      schema: {
        params: dependencyParamsSchema,
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
      const dependsOnNumber = parseTaskParam(
        request.params.dependsOnTaskId,
        projectId,
      );

      await service.removeDependency(projectId, taskNumber, dependsOnNumber);
      return reply.status(200).send({ status: 'ok' });
    },
  );

  // 8. Get task dependencies (ancestors & descendants with depth distance)
  app.withTypeProvider<ZodTypeProvider>().get(
    '/projects/:projectId/tasks/:taskId/dependencies',
    {
      preHandler: [projectGuard],
      schema: {
        params: taskParamsSchema,
        response: {
          200: taskDependenciesResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const projectId = request.project?.id;
      if (!projectId) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      const taskNumber = parseTaskParam(request.params.taskId, projectId);
      const result = await service.getTaskDependencies(projectId, taskNumber);
      return reply.status(200).send(result);
    },
  );
}

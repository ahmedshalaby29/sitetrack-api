import { defaultClock, type Clock } from '../../lib/clock.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { TasksRepo } from './repo.js';
import type {
  CreateTaskBody,
  ListTasksQuery,
  TaskResponse,
  UpdateTaskBody,
} from './schemas.js';

export class TasksService {
  constructor(
    private readonly repo: TasksRepo = new TasksRepo(),
    private readonly clock: Clock = defaultClock,
  ) {}

  async createTask(
    projectId: number,
    input: CreateTaskBody,
  ): Promise<TaskResponse> {
    return this.repo.createTask(projectId, input, this.clock.today());
  }

  async getTask(projectId: number, taskNumber: number): Promise<TaskResponse> {
    const task = await this.repo.getTask(
      projectId,
      taskNumber,
      this.clock.today(),
    );
    if (!task) {
      throw new AppError(404, ErrorCode.TASK_NOT_FOUND, 'Task not found');
    }
    return task;
  }

  async listTasks(
    projectId: number,
    query: ListTasksQuery,
  ): Promise<{ tasks: TaskResponse[]; total: number }> {
    return this.repo.listTasks(projectId, query, this.clock.today());
  }

  async updateTask(
    projectId: number,
    taskNumber: number,
    input: UpdateTaskBody,
  ): Promise<TaskResponse> {
    const task = await this.repo.updateTask(
      projectId,
      taskNumber,
      input,
      this.clock.today(),
    );
    if (!task) {
      throw new AppError(404, ErrorCode.TASK_NOT_FOUND, 'Task not found');
    }
    return task;
  }

  async deleteTask(projectId: number, taskNumber: number): Promise<void> {
    const deleted = await this.repo.deleteTask(projectId, taskNumber);
    if (!deleted) {
      throw new AppError(404, ErrorCode.TASK_NOT_FOUND, 'Task not found');
    }
  }
}

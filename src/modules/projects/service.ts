import { AppError, ErrorCode } from '../../lib/errors.js';
import type { ProjectsRepo } from './repo.js';
import type {
  CreateProjectInput,
  ListProjectsQuery,
  ProjectListResponse,
  ProjectResponse,
  UpdateProjectInput,
} from './schemas.js';

export class ProjectsService {
  constructor(private readonly repo: ProjectsRepo) {}

  async create(
    userId: number,
    input: CreateProjectInput,
  ): Promise<ProjectResponse> {
    return this.repo.createProject(userId, input);
  }

  async getById(projectId: number, userId: number): Promise<ProjectResponse> {
    const project = await this.repo.getProjectById(projectId, userId);
    if (!project) {
      throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
    }
    return project;
  }

  async list(
    userId: number,
    isSuperAdmin: boolean,
    query?: ListProjectsQuery,
    now?: Date,
  ): Promise<ProjectListResponse> {
    return this.repo.listProjects(userId, isSuperAdmin, query, now);
  }

  async update(
    projectId: number,
    userId: number,
    input: UpdateProjectInput,
  ): Promise<ProjectResponse> {
    const project = await this.repo.updateProject(projectId, userId, input);
    if (!project) {
      throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
    }
    return project;
  }

  async delete(projectId: number): Promise<void> {
    await this.repo.softDeleteProject(projectId);
  }
}

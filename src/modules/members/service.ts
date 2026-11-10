import { AppError, ErrorCode } from '../../lib/errors.js';
import type { MembersRepo } from './repo.js';
import type { ProjectMember } from './schemas.js';

export class MembersService {
  constructor(private readonly repo: MembersRepo) {}

  async list(projectId: number): Promise<ProjectMember[]> {
    return this.repo.listMembers(projectId);
  }

  async promote(projectId: number, targetUserId: number): Promise<void> {
    const ok = await this.repo.promoteMember(projectId, targetUserId);
    if (!ok) {
      throw new AppError(
        404,
        ErrorCode.MEMBER_NOT_FOUND,
        'Member not found in project',
      );
    }
  }

  async demote(projectId: number, targetUserId: number): Promise<void> {
    try {
      await this.repo.demoteMember(projectId, targetUserId);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === 'MEMBER_NOT_FOUND') {
          throw new AppError(
            404,
            ErrorCode.MEMBER_NOT_FOUND,
            'Member not found in project',
          );
        }
        if (err.message === 'LAST_ADMIN') {
          throw new AppError(
            409,
            ErrorCode.LAST_PROJECT_ADMIN,
            'Cannot demote the last project admin',
          );
        }
      }
      throw err;
    }
  }

  async remove(
    projectId: number,
    callerUserId: number,
    targetUserId: number,
    isCallerAdmin: boolean,
  ): Promise<void> {
    // A member can leave, or an admin can remove any member
    if (callerUserId !== targetUserId && !isCallerAdmin) {
      throw new AppError(
        403,
        ErrorCode.FORBIDDEN,
        'Only project admins can remove other members',
      );
    }

    try {
      await this.repo.removeMember(projectId, targetUserId);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === 'MEMBER_NOT_FOUND') {
          throw new AppError(
            404,
            ErrorCode.MEMBER_NOT_FOUND,
            'Member not found in project',
          );
        }
        if (err.message === 'LAST_ADMIN') {
          throw new AppError(
            409,
            ErrorCode.LAST_PROJECT_ADMIN,
            'Cannot remove the last project admin',
          );
        }
      }
      throw err;
    }
  }
}

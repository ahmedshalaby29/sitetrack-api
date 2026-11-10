import { AppError, ErrorCode } from '../../lib/errors.js';
import type { InvitationsRepo } from './repo.js';
import type {
  CreateInvitationInput,
  InvitationResponse,
  NotificationListResponse,
} from './schemas.js';

export class InvitationsService {
  constructor(private readonly repo: InvitationsRepo) {}

  /**
   * Invites a user by email (Decision 10).
   * - Unknown email returns generic 422 error.
   * - Inviting an existing member returns 409.
   * - Duplicate pending invite returns 409 (enforced by partial unique index).
   */
  async create(
    projectId: number,
    invitedByUserId: number,
    input: CreateInvitationInput,
  ): Promise<InvitationResponse> {
    const targetUser = await this.repo.findUserByEmail(input.email);
    if (!targetUser) {
      throw new AppError(
        422,
        ErrorCode.INVALID_INVITATION,
        'Cannot invite this email address',
      );
    }

    const isMember = await this.repo.isProjectMember(projectId, targetUser.id);
    if (isMember) {
      throw new AppError(
        409,
        ErrorCode.ALREADY_MEMBER,
        'User is already a member of this project',
      );
    }

    try {
      return await this.repo.createInvitation(
        projectId,
        targetUser.id,
        invitedByUserId,
      );
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new AppError(
          409,
          ErrorCode.DUPLICATE_INVITATION,
          'A pending invitation already exists for this user in this project',
        );
      }
      throw err;
    }
  }

  async listProjectInvitations(
    projectId: number,
  ): Promise<InvitationResponse[]> {
    return this.repo.listProjectInvitations(projectId);
  }

  async withdraw(projectId: number, invitationId: number): Promise<void> {
    const ok = await this.repo.withdrawInvitation(projectId, invitationId);
    if (!ok) {
      throw new AppError(
        404,
        ErrorCode.INVITATION_NOT_FOUND,
        'Invitation not found or already resolved',
      );
    }
  }

  async listUserNotifications(
    userId: number,
  ): Promise<NotificationListResponse> {
    const notifications = await this.repo.listUserNotifications(userId);
    const unreadCount = notifications.filter((n) => !n.isRead).length;
    return {
      notifications,
      unreadCount,
    };
  }

  async accept(
    invitationId: number,
    userId: number,
  ): Promise<InvitationResponse> {
    try {
      return await this.repo.acceptInvitation(invitationId, userId);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === 'NOT_FOUND') {
          throw new AppError(
            404,
            ErrorCode.INVITATION_NOT_FOUND,
            'Invitation not found',
          );
        }
        if (err.message === 'NOT_PENDING') {
          throw new AppError(
            409,
            ErrorCode.INVITATION_NOT_PENDING,
            'Invitation is not in pending state',
          );
        }
      }
      throw err;
    }
  }

  async reject(
    invitationId: number,
    userId: number,
  ): Promise<InvitationResponse> {
    try {
      return await this.repo.rejectInvitation(invitationId, userId);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === 'NOT_FOUND') {
          throw new AppError(
            404,
            ErrorCode.INVITATION_NOT_FOUND,
            'Invitation not found',
          );
        }
        if (err.message === 'NOT_PENDING') {
          throw new AppError(
            409,
            ErrorCode.INVITATION_NOT_PENDING,
            'Invitation is not in pending state',
          );
        }
      }
      throw err;
    }
  }

  async markAsRead(invitationId: number, userId: number): Promise<void> {
    const ok = await this.repo.markAsRead(invitationId, userId);
    if (!ok) {
      throw new AppError(
        404,
        ErrorCode.INVITATION_NOT_FOUND,
        'Invitation not found',
      );
    }
  }
}

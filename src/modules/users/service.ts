import { AppError, ErrorCode } from '../../lib/errors.js';
import * as repo from './repo.js';

export async function changeUserRole(
  userId: number,
  newRole: 'user' | 'store_manager' | 'super_admin',
): Promise<repo.UserSummary> {
  const updated = await repo.updateUserRole(userId, newRole);
  if (!updated) {
    throw new AppError(404, ErrorCode.USER_NOT_FOUND, 'User not found');
  }
  return updated;
}

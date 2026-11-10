/**
 * Error envelope types and helpers.
 *
 * Rule 10: Every error response is `{ "error": { "code": "...", "message": "..." } }`.
 * No stack traces, no SQL errors, no internal details in messages.
 */

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

/**
 * Typed application error that maps to a specific HTTP status and error code.
 * Throw this from services or routes; the global error handler serialises it.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// ── Well-known error codes ──────────────────────────────────────────────────

export const ErrorCode = {
  // 400
  VALIDATION: 'VALIDATION',
  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  // 403
  FORBIDDEN: 'FORBIDDEN',
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  MATERIAL_NOT_FOUND: 'MATERIAL_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  // 409
  CONFLICT: 'CONFLICT',
  EMAIL_EXISTS: 'EMAIL_EXISTS',
  LAST_PROJECT_ADMIN: 'LAST_PROJECT_ADMIN',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  DUPLICATE_INVITATION: 'DUPLICATE_INVITATION',
  INVITATION_NOT_PENDING: 'INVITATION_NOT_PENDING',
  MATERIAL_EXISTS: 'MATERIAL_EXISTS',
  MATERIAL_IN_USE: 'MATERIAL_IN_USE',
  // 422
  UNPROCESSABLE: 'UNPROCESSABLE',
  INVALID_INVITATION: 'INVALID_INVITATION',
  INVALID_TASK_DATES: 'INVALID_TASK_DATES',
  // 500
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeKey = keyof typeof ErrorCode;

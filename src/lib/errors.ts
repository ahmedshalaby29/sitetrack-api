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
  // 409
  CONFLICT: 'CONFLICT',
  EMAIL_EXISTS: 'EMAIL_EXISTS',
  // 422
  UNPROCESSABLE: 'UNPROCESSABLE',
  // 500
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeKey = keyof typeof ErrorCode;

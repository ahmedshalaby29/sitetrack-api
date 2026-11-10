import { describe, it, expect } from 'vitest';
import { AppError, ErrorCode, errorEnvelope } from '../../lib/errors.js';

describe('errorEnvelope', () => {
  it('returns the standard error shape', () => {
    const result = errorEnvelope('SOME_CODE', 'some message');
    expect(result).toStrictEqual({
      error: { code: 'SOME_CODE', message: 'some message' },
    });
  });
});

describe('AppError', () => {
  it('stores statusCode, code, and message', () => {
    const err = new AppError(409, ErrorCode.CONFLICT, 'already exists');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('already exists');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('is distinguishable from a plain Error', () => {
    const err = new AppError(400, ErrorCode.VALIDATION, 'bad');
    expect(err.name).toBe('AppError');
  });
});

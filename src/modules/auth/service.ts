import { AppError, ErrorCode } from '../../lib/errors.js';
import {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
} from '../../lib/passwords.js';
import {
  createAccessToken,
  generateOpaqueRefreshToken,
  hashRefreshToken,
} from '../../lib/tokens.js';
import type { AuthRepo } from './repo.js';
import type {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
} from './schemas.js';

// Default session expiration: 30 days
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export class AuthService {
  constructor(private readonly repo: AuthRepo) {}

  /**
   * Registers a new user account.
   *
   * Enforces:
   * - ALLOW_PRIVILEGED_SELF_REGISTRATION check (context.md decision 2)
   * - Argon2 password hashing
   * - Case-insensitive email uniqueness (Postgres error 23505 -> 409 EMAIL_EXISTS)
   * - Session creation with hashed opaque refresh token
   * - 15m JWT access token
   */
  async register(input: RegisterRequest): Promise<AuthResponse> {
    const allowPrivileged =
      process.env['ALLOW_PRIVILEGED_SELF_REGISTRATION'] !== 'false';

    if (!allowPrivileged && input.role !== 'user') {
      throw new AppError(
        403,
        ErrorCode.FORBIDDEN_ROLE,
        'Privileged self-registration is disabled',
      );
    }

    const hashedPassword = await hashPassword(input.password);

    let user;
    try {
      user = await this.repo.createUser(
        input.name,
        input.email,
        hashedPassword,
        input.role,
      );
    } catch (err: unknown) {
      // Postgres unique_violation error code is 23505
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new AppError(
          409,
          ErrorCode.EMAIL_EXISTS,
          'An account with this email already exists',
        );
      }
      throw err;
    }

    const rawRefreshToken = generateOpaqueRefreshToken();
    const hashedRefreshToken = hashRefreshToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS);

    const session = await this.repo.createSession(
      user.id,
      hashedRefreshToken,
      expiresAt,
    );

    const accessToken = await createAccessToken(user.id, session.id);

    return {
      user,
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }

  /**
   * Authenticates an existing user.
   *
   * Enforces:
   * - Timing-safe password verification when email is unknown (rule 79)
   * - Identical generic error for unknown email or wrong password
   * - Creates a new session with hashed refresh token
   * - Generates a 15m JWT access token with claims `sub` and `sid`
   */
  async login(input: LoginRequest): Promise<AuthResponse> {
    const user = await this.repo.findUserForAuth(input.email);

    if (!user) {
      // Timing attack mitigation: run dummy verify against fixed hash
      await verifyDummyPassword(input.password);
      throw new AppError(
        401,
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid email or password',
      );
    }

    const passwordMatches = await verifyPassword(user.passwordHash, input.password);
    if (!passwordMatches) {
      throw new AppError(
        401,
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid email or password',
      );
    }

    const rawRefreshToken = generateOpaqueRefreshToken();
    const hashedRefreshToken = hashRefreshToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS);

    const session = await this.repo.createSession(
      user.id,
      hashedRefreshToken,
      expiresAt,
    );

    const accessToken = await createAccessToken(user.id, session.id);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
      },
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }
}

import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const DEFAULT_SECRET = 'sitetrack_jwt_default_secret_for_dev_and_testing_only_12345';

function getJwtSecret(): Uint8Array {
  const secret = process.env['JWT_SECRET'] ?? DEFAULT_SECRET;
  return new TextEncoder().encode(secret);
}

export interface AccessTokenPayload extends JWTPayload {
  sub: string; // user id
  sid: string; // session id (UUID)
}

/**
 * Creates a signed 15-minute JWT carrying only `sub` (userId) and `sid` (sessionId).
 * Non-negotiable rule 1: Role and membership are never stored in the JWT.
 */
export async function createAccessToken(
  userId: number | string,
  sessionId: string,
): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(getJwtSecret());
}

/**
 * Verifies an access token JWT and returns its payload.
 * Throws if expired, invalid signature, or missing required claims.
 */
export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getJwtSecret());
  if (!payload.sub || typeof payload['sid'] !== 'string') {
    throw new Error('Invalid token payload: missing sub or sid');
  }
  return payload as AccessTokenPayload;
}

/**
 * Generates an opaque random string to be sent to the client as a refresh token.
 */
export function generateOpaqueRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Hashes a refresh token using SHA-256 for secure storage in the database.
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

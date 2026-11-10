import { hash, verify } from '@node-rs/argon2';

// Pre-computed valid argon2id hash of a dummy password.
// Used when an unknown email attempts login, so timing remains indistinguishable
// from a failed password attempt for an existing user (preventing user enumeration).
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$7n6/jWv8V+qH3pYnU1q9cA$8bUsmXWjB1rJ6VpX9Z7Qp6lZ7oF4Y+X0a1V3U2y9o+k';

/**
 * Hashes a plaintext password using Argon2id.
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/**
 * Verifies a plaintext password against an Argon2id hash.
 */
export async function verifyPassword(
  hashedPassword: string,
  plainPassword: string,
): Promise<boolean> {
  return verify(hashedPassword, plainPassword);
}

/**
 * Performs a dummy Argon2 verification to match response timing when
 * an unknown email attempts login. Always resolves, ignoring the result.
 */
export async function verifyDummyPassword(plainPassword: string): Promise<void> {
  try {
    await verify(DUMMY_HASH, plainPassword);
  } catch {
    // Intentionally ignored
  }
}

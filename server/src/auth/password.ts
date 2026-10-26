import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt is a memory-hard, purpose-built password hashing function (RFC 7914).
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
const MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...options, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await derive(password, Buffer.from(saltB64, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Hash of a random password, used to keep login timing similar when the username does not exist. */
export const DUMMY_HASH_PROMISE = hashPassword(randomBytes(16).toString('hex'));

export function passwordPolicyProblem(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 256) return 'Password is too long';
  return null;
}

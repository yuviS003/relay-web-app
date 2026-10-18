import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

type ScryptParams = { N: number; r: number; p: number };

/*
 * promisify's inference picks the three-argument overload and drops the one
 * that accepts tuning parameters, so the signature is restated here. Without
 * this the cost settings below would be silently unusable.
 */
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptParams,
) => Promise<Buffer>;

/*
 * Password storage.
 *
 * scrypt rather than a plain hash: SHA-256 of a password is crackable at
 * billions of guesses per second on a GPU. scrypt is deliberately slow and
 * memory-hard, which is what makes an offline attack on a leaked database
 * expensive rather than a formality.
 *
 * Node ships scrypt in core, so this needs no dependency. bcrypt and argon2
 * are both fine choices too; argon2id is the modern preference, but it means a
 * native module, and the win over correctly-parameterised scrypt is small
 * enough that avoiding a build-time dependency is worth more here.
 *
 * Parameters are stored alongside the hash so they can be raised later without
 * invalidating existing passwords: verification reads the cost from the record
 * it is checking, not from this file.
 */

const COST = 16_384; // N: 2^14 iterations
const BLOCK_SIZE = 8; // r
const PARALLELISM = 1; // p
const KEY_BYTES = 64;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 10;
/*
 * An upper bound matters: scrypt cost grows with input, so an unbounded field
 * lets an attacker burn server CPU with a megabyte "password".
 */
export const MAX_PASSWORD_LENGTH = 200;

export type PasswordProblem =
  | 'too-short'
  | 'too-long'
  | 'too-common'
  | 'whitespace-only';

/*
 * A short denylist of the passwords that actually show up first in credential
 * stuffing. Not a substitute for a breach-corpus check; it removes the worst
 * offenders at zero cost and no network dependency.
 */
const COMMON = new Set([
  'password',
  'password1',
  'password123',
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'iloveyou123',
  'letmein123',
  'adminadmin',
  'passw0rd123',
]);

export function checkPasswordStrength(password: string): PasswordProblem | null {
  if (password.trim() === '') return 'whitespace-only';
  if (password.length < MIN_PASSWORD_LENGTH) return 'too-short';
  if (password.length > MAX_PASSWORD_LENGTH) return 'too-long';
  if (COMMON.has(password.toLowerCase())) return 'too-common';
  return null;
}

/** Produces `scrypt$N$r$p$salt$hash`, carrying its own parameters. */
export async function hashPassword(password: string): Promise<string> {
  const problem = checkPasswordStrength(password);
  if (problem) throw new Error(`Password rejected: ${problem}`);

  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(password, salt, KEY_BYTES, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
  })) as Buffer;

  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, costRaw, blockRaw, parallelRaw, saltRaw, hashRaw] = parts;
  const cost = Number(costRaw);
  const blockSize = Number(blockRaw);
  const parallelism = Number(parallelRaw);

  if (
    !Number.isInteger(cost) ||
    !Number.isInteger(blockSize) ||
    !Number.isInteger(parallelism) ||
    cost < 1024 ||
    cost > 1_048_576
  ) {
    // Refuse to honour an absurd cost from a tampered record: a cost of 2^30
    // would hang the process, turning a login attempt into a denial of service.
    return false;
  }

  if (password.length > MAX_PASSWORD_LENGTH) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(hashRaw ?? '', 'base64');
  } catch {
    return false;
  }
  if (expected.length !== KEY_BYTES) return false;

  let derived: Buffer;
  try {
    derived = (await scryptAsync(
      password,
      Buffer.from(saltRaw ?? '', 'base64'),
      KEY_BYTES,
      { N: cost, r: blockSize, p: parallelism },
    )) as Buffer;
  } catch {
    return false;
  }

  // Constant time: a byte-by-byte early exit leaks how much of the hash
  // matched, which is enough to reconstruct it one byte at a time.
  return timingSafeEqual(derived, expected);
}

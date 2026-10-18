import { createHash, randomInt } from 'node:crypto';

/*
 * Recovery codes: the way back in when the authenticator is gone.
 *
 * Stored as SHA-256 digests, not scrypt. These are not passwords — each code
 * is ~50 bits of uniform randomness from a CSPRNG, so there is no dictionary
 * to try and nothing for key stretching to buy; the sign-in throttle covers
 * online guessing. Hashing at all is what keeps a leaked database from being
 * a set of working second factors.
 *
 * Each code is single use: consuming one returns the remaining digests for the
 * caller to persist, so a code read over someone's shoulder stops working.
 */

// No 'i', 'l', 'o' or '1': these get written down and typed back by hand.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 10;
export const RECOVERY_CODE_COUNT = 8;

function randomCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** Strips the display formatting so "A1B2C-D3E4F" matches "a1b2cd3e4f". */
export function normaliseRecoveryCode(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hashRecoveryCode(input: unknown): string {
  return createHash('sha256').update(normaliseRecoveryCode(input)).digest('hex');
}

export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Fresh codes. The plaintext is returned once, for display, and only the
 * digests are meant to be stored.
 */
export function createRecoveryCodes(count = RECOVERY_CODE_COUNT): {
  codes: string[];
  hashes: string[];
} {
  const codes = Array.from({ length: count }, () => formatRecoveryCode(randomCode()));
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/**
 * Spends a code. Returns the digests that remain, or null when the code is not
 * one of them.
 */
export function consumeRecoveryCode(
  hashes: readonly string[],
  input: unknown,
): string[] | null {
  const candidate = normaliseRecoveryCode(input);
  if (candidate.length !== CODE_LENGTH) return null;

  const digest = hashRecoveryCode(candidate);
  if (!hashes.includes(digest)) return null;
  return hashes.filter((entry) => entry !== digest);
}

export function isRecoveryCodeShaped(input: unknown): boolean {
  return normaliseRecoveryCode(input).length === CODE_LENGTH;
}

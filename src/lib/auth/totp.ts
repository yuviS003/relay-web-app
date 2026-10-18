import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/*
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP).
 *
 * Implemented here rather than pulled in: the algorithm is an HMAC, a
 * truncation and a modulo, all of which Node's crypto already provides, and
 * the authenticator-app interop surface is a base32 secret plus an otpauth
 * URI. SHA-1 is not a free choice — it is what Google Authenticator, Aegis,
 * 1Password and the rest implement, and HMAC-SHA1 is unaffected by SHA-1's
 * collision weaknesses.
 *
 * Verification accepts one step either side of now (RFC 6238 §5.2) so a clock
 * a few seconds out still works. The caller is expected to persist the step a
 * code matched and refuse anything at or below it, which is what stops a code
 * observed in transit from being replayed inside its own window.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const TOTP_ISSUER = 'Relay';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Trailing bits are left-aligned into a final character; no '=' padding,
  // because authenticator apps and otpauth URIs do not use it.
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (clean === '') throw new Error('Secret is empty');

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new Error('Secret is not valid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, the size RFC 4226 §4 recommends for HMAC-SHA1. */
export function createTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();

  // Dynamic truncation: the low nibble of the last byte picks the 4-byte
  // window, and the top bit is masked off so the result is sign-independent.
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fff_ffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(
  secret: string,
  atMs: number = Date.now(),
  digits = TOTP_DIGITS,
): string {
  return hotp(base32Decode(secret), totpStep(atMs), digits);
}

function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function isTotpCodeShaped(input: unknown): input is string {
  return typeof input === 'string' && /^\d{6}$/.test(input.replace(/\s/g, ''));
}

/**
 * Returns the time step the code matched, or null. The step is the caller's
 * replay guard: persist it and reject codes from that step or earlier.
 */
export function verifyTotp(
  secret: string,
  code: unknown,
  // `after` is explicitly optional-or-undefined: callers pass a stored value
  // that may not exist yet, and exactOptionalPropertyTypes would reject it.
  options: { atMs?: number; window?: number; after?: number | undefined } = {},
): number | null {
  if (typeof code !== 'string') return null;
  const candidate = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) return null;

  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return null;
  }

  const { atMs = Date.now(), window = TOTP_WINDOW, after } = options;
  const current = totpStep(atMs);

  for (let drift = -window; drift <= window; drift += 1) {
    const step = current + drift;
    if (after !== undefined && step <= after) continue;
    if (sameCode(hotp(key, step), candidate)) return step;
  }
  return null;
}

/** The URI an authenticator app reads from the QR code. */
export function otpauthUri(email: string, secret: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}



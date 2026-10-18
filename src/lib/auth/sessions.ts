import { createHash, randomBytes } from 'node:crypto';

/*
 * Session handling.
 *
 * Opaque random tokens stored server-side, not signed JWTs. A JWT cannot be
 * revoked before it expires without a server-side blocklist, at which point
 * the stateless benefit is gone and you have a worse database lookup. An
 * opaque token means "sign out everywhere" is a delete.
 *
 * Only the SHA-256 of the token is persisted. A leaked database therefore
 * yields hashes, not usable sessions — the same reasoning as password hashing,
 * though a fast hash suffices here because a 256-bit random token is not
 * guessable and needs no stretching.
 */

export const SESSION_COOKIE = 'wac_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

/*
 * A half-finished sign-in lives in its own short-lived cookie rather than in
 * the session cookie. The password step is already proven at that point, so a
 * token that both names the user and is accepted anywhere would be a bypass
 * waiting for one missing check; a separate name means the session cookie is
 * never a "maybe".
 */
export const MFA_COOKIE = 'wac_mfa';
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/*
 * The handle for an in-flight passkey sign-in. It names a stored challenge,
 * not an account, so it is useless on its own — but it must still be
 * unguessable and short-lived, hence a token in an HttpOnly cookie rather than
 * an id in the page.
 */
export const PASSKEY_COOKIE = 'wac_pk';

export type SessionRecord = {
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  /** Set while the second factor is outstanding. Never a usable session. */
  pendingMfa?: boolean;
};

export function createSessionToken(): { token: string; tokenHash: string } {
  // base64url so the value is cookie-safe without escaping.
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function buildSessionRecord(userId: string, tokenHash: string): SessionRecord {
  const now = new Date();
  return {
    tokenHash,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
}

export function buildChallengeRecord(
  userId: string,
  tokenHash: string,
): SessionRecord {
  const now = new Date();
  return {
    tokenHash,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS),
    pendingMfa: true,
  };
}

/**
 * Serialises the session cookie.
 *
 * HttpOnly so script cannot read it, which limits what an XSS can steal.
 * SameSite=Lax so another site cannot ride the session on a state-changing
 * request. Secure in production only, because a localhost cookie over plain
 * HTTP would otherwise be dropped and login would appear to silently fail.
 */
function serialise(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function sessionCookie(token: string, secure: boolean): string {
  return serialise(
    SESSION_COOKIE,
    token,
    Math.floor(SESSION_TTL_MS / 1000),
    secure,
  );
}

export function clearedSessionCookie(secure: boolean): string {
  return serialise(SESSION_COOKIE, '', 0, secure);
}

export function mfaChallengeCookie(token: string, secure: boolean): string {
  return serialise(
    MFA_COOKIE,
    token,
    Math.floor(MFA_CHALLENGE_TTL_MS / 1000),
    secure,
  );
}

export function clearedMfaChallengeCookie(secure: boolean): string {
  return serialise(MFA_COOKIE, '', 0, secure);
}

/** Reads one of our opaque tokens out of a Cookie header. */
export function readCookieToken(
  cookieHeader: string | null,
  name: string,
): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    const value = part.slice(separator + 1).trim();
    // Reject anything that is not plausibly our token rather than passing it
    // to a database query.
    return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
  }
  return null;
}

export function readSessionToken(cookieHeader: string | null): string | null {
  return readCookieToken(cookieHeader, SESSION_COOKIE);
}

export function readMfaChallengeToken(cookieHeader: string | null): string | null {
  return readCookieToken(cookieHeader, MFA_COOKIE);
}

export function passkeyHandleCookie(token: string, secure: boolean): string {
  return serialise(
    PASSKEY_COOKIE,
    token,
    Math.floor(MFA_CHALLENGE_TTL_MS / 1000),
    secure,
  );
}

export function clearedPasskeyHandleCookie(secure: boolean): string {
  return serialise(PASSKEY_COOKIE, '', 0, secure);
}

export function readPasskeyHandle(cookieHeader: string | null): string | null {
  return readCookieToken(cookieHeader, PASSKEY_COOKIE);
}

const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function normaliseEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  return EMAIL.test(email) ? email : null;
}

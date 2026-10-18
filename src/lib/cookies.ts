/*
 * A cookie jar.
 *
 * Needed because a session is usually two requests: one that signs in and
 * returns Set-Cookie, and everything after it that must send the cookie back.
 * Without a jar, every collection run has to copy a header by hand.
 *
 * Scoping is enforced rather than assumed. A cookie is only returned to a host
 * its domain covers, over a path it covers, and a Secure cookie is never sent
 * over plain http — a jar that ignores any of those turns one captured cookie
 * into credentials leaked to the next unrelated host in the collection.
 *
 * Nothing here persists. The jar lives in memory for the session: cookies are
 * credentials, and writing them to disk in a browser profile the user did not
 * choose is a liability with no matching benefit.
 */

export type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  /** True when the cookie had no Domain attribute: exact host match only. */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'strict' | 'lax' | 'none' | null;
  /** Epoch milliseconds, or null for a session cookie. */
  expiresAt: number | null;
};

export type CookieJar = readonly StoredCookie[];

export const EMPTY_JAR: CookieJar = [];

function parseExpires(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

/** Parses one Set-Cookie value in the context of the URL that returned it. */
export function parseSetCookie(
  header: string,
  requestUrl: string,
  now = Date.now(),
): StoredCookie | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  const parts = header.split(';');
  const [pair, ...attributes] = parts;
  if (!pair) return null;

  const separator = pair.indexOf('=');
  // A Set-Cookie with no "=" is not a cookie; browsers drop it too.
  if (separator <= 0) return null;

  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (name === '') return null;

  const cookie: StoredCookie = {
    name,
    value,
    domain: url.hostname.toLowerCase(),
    hostOnly: true,
    path: defaultPath(url.pathname),
    secure: false,
    httpOnly: false,
    sameSite: null,
    expiresAt: null,
  };

  let maxAge: number | null = null;
  let expires: number | null = null;

  for (const attribute of attributes) {
    const index = attribute.indexOf('=');
    const key = (index === -1 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const raw = index === -1 ? '' : attribute.slice(index + 1).trim();

    switch (key) {
      case 'domain': {
        const domain = raw.replace(/^\./, '').toLowerCase();
        if (domain === '') break;
        /*
         * The cookie may only widen to a domain that covers the host it came
         * from, and never to a bare suffix like "com": without the public
         * suffix list, requiring a dot and a real suffix match is the
         * conservative rule.
         */
        const host = url.hostname.toLowerCase();
        const covers = host === domain || host.endsWith(`.${domain}`);
        if (!covers || !domain.includes('.')) break;
        return parseWithDomain(cookie, domain, attributes, url, now);
      }
      case 'path':
        if (raw.startsWith('/')) cookie.path = raw;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite': {
        const mode = raw.toLowerCase();
        if (mode === 'strict' || mode === 'lax' || mode === 'none') {
          cookie.sameSite = mode;
        }
        break;
      }
      case 'max-age': {
        const seconds = Number(raw);
        if (Number.isFinite(seconds)) maxAge = now + seconds * 1000;
        break;
      }
      case 'expires':
        expires = parseExpires(raw);
        break;
      default:
        break;
    }
  }

  // Max-Age wins over Expires (RFC 6265 §5.3).
  cookie.expiresAt = maxAge ?? expires;
  return cookie;
}

function parseWithDomain(
  base: StoredCookie,
  domain: string,
  attributes: string[],
  url: URL,
  now: number,
): StoredCookie {
  // Re-read the remaining attributes with the domain decided, so ordering in
  // the header cannot change the result.
  const rest = parseSetCookie(
    [`${base.name}=${base.value}`, ...attributes.filter((entry) => !/^\s*domain=/i.test(entry))].join(
      ';',
    ),
    url.href,
    now,
  );
  return {
    ...(rest ?? base),
    domain,
    hostOnly: false,
  };
}

function domainMatches(cookie: StoredCookie, host: string): boolean {
  const target = host.toLowerCase();
  if (cookie.hostOnly) return target === cookie.domain;
  return target === cookie.domain || target.endsWith(`.${cookie.domain}`);
}

function pathMatches(cookie: StoredCookie, pathname: string): boolean {
  if (cookie.path === '/') return true;
  if (pathname === cookie.path) return true;
  return (
    pathname.startsWith(cookie.path) &&
    (cookie.path.endsWith('/') || pathname[cookie.path.length] === '/')
  );
}

function sameCookie(a: StoredCookie, b: StoredCookie): boolean {
  return a.name === b.name && a.domain === b.domain && a.path === b.path;
}

/** Applies every Set-Cookie from one response, returning the new jar. */
export function applySetCookies(
  jar: CookieJar,
  headers: readonly string[],
  requestUrl: string,
  now = Date.now(),
): CookieJar {
  let next = [...jar];

  for (const header of headers) {
    const cookie = parseSetCookie(header, requestUrl, now);
    if (!cookie) continue;

    next = next.filter((existing) => !sameCookie(existing, cookie));
    // An expiry in the past is a deletion, which is how servers log you out.
    if (cookie.expiresAt !== null && cookie.expiresAt <= now) continue;
    next.push(cookie);
  }

  return next;
}

/** The Cookie header for a URL, or '' when nothing in the jar applies. */
export function cookieHeaderFor(
  jar: CookieJar,
  requestUrl: string,
  now = Date.now(),
): string {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return '';
  }
  const secureTransport = url.protocol === 'https:';

  const matching = jar
    .filter((cookie) => cookie.expiresAt === null || cookie.expiresAt > now)
    .filter((cookie) => domainMatches(cookie, url.hostname))
    .filter((cookie) => pathMatches(cookie, url.pathname))
    .filter((cookie) => !cookie.secure || secureTransport)
    // Longer paths first (RFC 6265 §5.4): the most specific cookie wins when a
    // server reads only the first of a repeated name.
    .sort((a, b) => b.path.length - a.path.length);

  return matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** Drops expired cookies, for display and for keeping the jar honest. */
export function pruneJar(jar: CookieJar, now = Date.now()): CookieJar {
  return jar.filter((cookie) => cookie.expiresAt === null || cookie.expiresAt > now);
}

export function removeCookie(
  jar: CookieJar,
  name: string,
  domain: string,
  path: string,
): CookieJar {
  return jar.filter(
    (cookie) =>
      !(cookie.name === name && cookie.domain === domain && cookie.path === path),
  );
}

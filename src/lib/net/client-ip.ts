import { isIP } from 'node:net';

/*
 * Who is calling?
 *
 * Rate limiting is only as good as the identity it counts against, and the
 * obvious identity is the wrong one. `X-Forwarded-For` is a request header, so
 * a direct client can send any value it likes; taking its first entry — the
 * usual shortcut — lets a caller mint a fresh allowance per request simply by
 * changing a string. That turns a limiter into decoration.
 *
 * Only two kinds of value are trusted here:
 *
 *   1. A platform header the infrastructure sets and overwrites on every
 *      request, so a client-supplied copy cannot survive to the application.
 *   2. `X-Forwarded-For`, counted from the RIGHT by the number of proxies the
 *      operator says are in front of the app (TRUSTED_PROXY_HOPS). Each trusted
 *      proxy appends the address it saw, so the entry `hops` from the end is
 *      the last address a trusted hop observed. Everything to the left of it is
 *      caller-supplied and ignored.
 *
 * When neither is available the caller is deliberately NOT identified. The
 * quota then charges one shared bucket for every unidentified caller, which is
 * stricter than per-caller limiting and — the point — cannot be escaped by
 * forging a header. Failing closed is the only safe default for a relay that
 * accepts guest traffic.
 */

/**
 * Headers set by the hosting platform's edge, which overwrites any value the
 * client sent. Checked before `X-Forwarded-For` because they need no operator
 * configuration to be trustworthy.
 */
const PLATFORM_HEADERS = [
  'x-vercel-forwarded-for',
  'cf-connecting-ip',
  'fly-client-ip',
] as const;

export type ClientIdentity = {
  /** The resolved address, or null when no trustworthy source was available. */
  ip: string | null;
  source: 'platform' | 'forwarded' | 'none';
  /** Stable key for a quota bucket. Never null, so callers cannot skip limiting. */
  key: string;
};

export const SHARED_BUCKET_KEY = 'shared:unidentified';

/** How many trusted proxies sit in front of the app. 0 disables XFF trust. */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) return 0;
  return parsed;
}

/**
 * Normalises one forwarded entry to a bare address.
 *
 * Proxies are inconsistent here: entries arrive as `1.2.3.4`, `1.2.3.4:5678`,
 * `[::1]`, `[::1]:443` or quoted. Returns null for anything that is not a
 * valid address, so a junk value becomes "unidentified" rather than its own
 * private bucket.
 */
export function normaliseAddress(input: string | undefined | null): string | null {
  if (!input) return null;
  let value = input.trim().replace(/^"|"$/g, '');
  if (value === '') return null;

  // Bracketed IPv6, optionally with a port: [::1]:443
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) value = bracketed[1];
  // IPv4 with a port. A bare IPv6 also contains colons, so only strip when
  // there is exactly one and the left side looks like IPv4.
  else if (value.split(':').length === 2 && isIP(value.split(':')[0] ?? '') === 4) {
    value = value.split(':')[0] as string;
  }

  // Scoped IPv6 (fe80::1%eth0) is the same host regardless of the zone.
  const scope = value.indexOf('%');
  if (scope !== -1) value = value.slice(0, scope);

  return isIP(value) === 0 ? null : value.toLowerCase();
}

/** Parses an X-Forwarded-For list into normalised addresses, order preserved. */
export function parseForwardedFor(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((entry) => normaliseAddress(entry))
    .filter((entry): entry is string => entry !== null);
}

/**
 * Resolves the calling client, trusting only sources that a client cannot
 * forge. See the module comment for why an unidentified caller is grouped
 * rather than given a bucket of its own.
 */
export function resolveClientIdentity(headers: Headers): ClientIdentity {
  for (const name of PLATFORM_HEADERS) {
    // These may themselves be a list (Vercel forwards the original XFF).
    const candidates = parseForwardedFor(headers.get(name));
    const platform = candidates[0];
    if (platform) return { ip: platform, source: 'platform', key: `ip:${platform}` };
  }

  const hops = trustedProxyHops();
  if (hops > 0) {
    const chain = parseForwardedFor(headers.get('x-forwarded-for'));
    // Counted from the right: the entry the outermost trusted proxy observed.
    const candidate = chain[chain.length - hops];
    if (candidate) return { ip: candidate, source: 'forwarded', key: `ip:${candidate}` };

    // X-Real-Ip is only meaningful when a proxy we trust is setting it.
    const real = normaliseAddress(headers.get('x-real-ip'));
    if (real) return { ip: real, source: 'forwarded', key: `ip:${real}` };
  }

  return { ip: null, source: 'none', key: SHARED_BUCKET_KEY };
}

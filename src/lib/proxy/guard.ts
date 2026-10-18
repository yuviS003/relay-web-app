import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/*
 * The security core of the whole project.
 *
 * A browser cannot send arbitrary cross-origin requests, so every request the
 * user composes has to be relayed by our server. That relay is the dangerous
 * part: an unrestricted one is a server-side request forgery weapon. Anyone
 * could point it at a cloud metadata endpoint to steal instance credentials,
 * or sweep the private network the server sits inside.
 *
 * Three rules, each closing a bypass that a naive implementation leaves open:
 *
 *  1. Decide on the resolved ADDRESS, never on the hostname. A blocklist of
 *     names is trivially defeated: `localtest.me` and countless public DNS
 *     records resolve to 127.0.0.1.
 *
 *  2. Check EVERY address the name resolves to, not just the first. A hostile
 *     record can return one public and one private address, and connecting to
 *     "whichever the OS picked" is a coin flip the attacker is happy to take.
 *
 *  3. Return the address so the caller can PIN the connection to it. Checking
 *     a name and then handing that name to an HTTP client means the client
 *     resolves it a second time; an attacker who controls the DNS can answer
 *     differently on that second lookup. That is DNS rebinding, and it defeats
 *     a validator that only inspects the URL.
 */

export type GuardFailure =
  | 'invalid-url'
  | 'unsupported-scheme'
  | 'embedded-credentials'
  | 'url-too-long'
  | 'unresolvable-host'
  | 'blocked-address';

export type GuardResult =
  | {
      ok: true;
      /** The address the request must connect to, with no further lookup. */
      address: string;
      family: 4 | 6;
      hostname: string;
      port: number;
      url: URL;
    }
  | { ok: false; reason: GuardFailure; detail: string };

const MAX_URL_LENGTH = 2048;

/** Parses dotted-quad IPv4 into a 32-bit integer, or null if malformed. */
function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    // Reject "01", "1e2", "+1" and similar: Number() is far too permissive,
    // and a lenient parser here is itself a bypass.
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * IPv4 ranges that must never be reachable through the proxy. Each entry is
 * [first, last] inclusive, chosen because reaching it means talking to
 * infrastructure rather than to the public internet.
 */
const BLOCKED_V4: readonly (readonly [string, string, string])[] = [
  ['0.0.0.0', '0.255.255.255', 'this-network'],
  ['10.0.0.0', '10.255.255.255', 'private'],
  ['100.64.0.0', '100.127.255.255', 'carrier-grade NAT'],
  ['127.0.0.0', '127.255.255.255', 'loopback'],
  ['169.254.0.0', '169.254.255.255', 'link-local, includes cloud metadata'],
  ['172.16.0.0', '172.31.255.255', 'private'],
  ['192.0.0.0', '192.0.0.255', 'IETF protocol assignments'],
  ['192.168.0.0', '192.168.255.255', 'private'],
  ['198.18.0.0', '198.19.255.255', 'benchmarking'],
  ['224.0.0.0', '239.255.255.255', 'multicast'],
  ['240.0.0.0', '255.255.255.255', 'reserved and broadcast'],
];

const BLOCKED_V4_RANGES = BLOCKED_V4.map(([start, end, label]) => {
  const first = ipv4ToInt(start);
  const last = ipv4ToInt(end);
  if (first === null || last === null) {
    throw new Error(`Malformed guard range: ${start}-${end}`);
  }
  return { first, last, label };
});

/** Expands an IPv6 address to eight 16-bit groups, or null if malformed. */
function expandIpv6(address: string): readonly number[] | null {
  let zoneless = address.split('%')[0] ?? address;

  /*
   * A trailing dotted-quad is legal IPv6 text: `::ffff:127.0.0.1` is how an
   * IPv4-mapped address is normally written. Rewriting it into two hex groups
   * lets the rest of the parser see one uniform shape. Without this the
   * expander returns null for exactly the notation an attacker would reach
   * for first.
   */
  const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(zoneless);
  if (embedded) {
    const packed = ipv4ToInt(embedded[2] ?? '');
    if (packed === null) return null;
    const high = (packed >>> 16) & 0xffff;
    const low = packed & 0xffff;
    zoneless = `${embedded[1]}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = zoneless.split('::');
  if (halves.length > 2) return null;

  const parse = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const groups: number[] = [];
    for (const part of chunk.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

function describeBlockedV4(address: string): string | null {
  const value = ipv4ToInt(address);
  if (value === null) return null;
  for (const range of BLOCKED_V4_RANGES) {
    if (value >= range.first && value <= range.last) return range.label;
  }
  return null;
}

/**
 * Returns a reason when the address must not be contacted, otherwise null.
 *
 * The IPv4-mapped IPv6 case matters more than it looks: `::ffff:127.0.0.1` is
 * loopback wearing an IPv6 costume, and a guard that only pattern-matches
 * IPv6 prefixes waves it straight through.
 */
export function describeBlockedAddress(address: string): string | null {
  const version = isIP(address);

  if (version === 4) return describeBlockedV4(address);
  if (version !== 6) return 'not a valid IP address';

  const groups = expandIpv6(address);
  if (!groups) return 'not a valid IP address';

  /*
   * Order matters. `::1` and `::` have all-zero leading groups, so the
   * IPv4-compatible test below also matches them and would unwrap `::1` into
   * 0.0.0.1 and report "this-network" instead of loopback. Both are still
   * blocked either way, but the reason would be wrong, and a wrong reason in
   * a security log is how a real bypass gets dismissed as noise.
   */
  if (groups.every((group) => group === 0)) return 'unspecified address';
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return 'loopback';
  }

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible: unwrap and judge as IPv4.
  const isMapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isCompat = groups.slice(0, 6).every((group) => group === 0);

  if (isMapped || isCompat) {
    /*
     * Unwrap so the log names the real target, then refuse regardless of what
     * it turns out to be. Refusing the whole notation, rather than only the
     * private addresses inside it, means the unwrapping above never has to be
     * flawless to stay safe: a bug here cannot open a hole, only mislabel a
     * rejection. A caller wanting a public host sends the plain IPv4 form.
     */
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    return describeBlockedV4(v4) ?? 'IPv4-mapped address';
  }

  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return 'unique local address';
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if ((first & 0xff00) === 0xff00) return 'multicast';

  return null;
}

/**
 * Validates a user-supplied target and resolves it to one pinned address.
 *
 * Callers must connect to `address` directly and send `hostname` as the Host
 * header. Passing the hostname back to an HTTP client re-opens the rebinding
 * hole this function exists to close.
 */
export type GuardOptions = {
  /*
   * Skips the address checks. This exists for two narrow reasons: the relay
   * test suite has to reach a server on 127.0.0.1, and a developer running
   * the tool locally may legitimately want to call their own dev API.
   *
   * It is a deliberate hole, so it is a parameter rather than a lookup: the
   * caller has to pass it in on every request, there is no ambient way to
   * switch it on, and the route only sets it from an explicit environment
   * flag that defaults to off.
   */
  allowPrivate?: boolean;
};

export async function guardTarget(
  raw: string,
  options: GuardOptions = {},
): Promise<GuardResult> {
  const allowPrivate = options.allowPrivate === true;

  if (raw.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      reason: 'url-too-long',
      detail: `URL exceeds ${MAX_URL_LENGTH} characters`,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid-url', detail: 'URL could not be parsed' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file:, gopher: and friends are how an SSRF turns into local file read.
    return {
      ok: false,
      reason: 'unsupported-scheme',
      detail: `Scheme ${url.protocol} is not allowed; use http or https`,
    };
  }

  if (url.username !== '' || url.password !== '') {
    // Credentials in the URL would be forwarded to whatever the host resolves
    // to, which is a quiet way to leak them.
    return {
      ok: false,
      reason: 'embedded-credentials',
      detail: 'Credentials in the URL are not allowed',
    };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

  // A literal IP needs no lookup, and must be judged exactly as given.
  if (isIP(hostname) !== 0) {
    const blocked = allowPrivate ? null : describeBlockedAddress(hostname);
    if (blocked) {
      return {
        ok: false,
        reason: 'blocked-address',
        detail: `${hostname} is not reachable (${blocked})`,
      };
    }
    return {
      ok: true,
      address: hostname,
      family: isIP(hostname) === 6 ? 6 : 4,
      hostname,
      port,
      url,
    };
  }

  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return {
      ok: false,
      reason: 'unresolvable-host',
      detail: `${hostname} could not be resolved`,
    };
  }

  if (resolved.length === 0) {
    return {
      ok: false,
      reason: 'unresolvable-host',
      detail: `${hostname} resolved to no addresses`,
    };
  }

  // Every answer must be acceptable. Filtering to the "safe ones" and
  // connecting to those would let a hostile record mix a public address in to
  // get past the check while the private one remains the real target.
  for (const entry of resolved) {
    const blocked = allowPrivate ? null : describeBlockedAddress(entry.address);
    if (blocked) {
      return {
        ok: false,
        reason: 'blocked-address',
        detail: `${hostname} resolves to ${entry.address} (${blocked})`,
      };
    }
  }

  const first = resolved[0];
  if (!first) {
    return {
      ok: false,
      reason: 'unresolvable-host',
      detail: `${hostname} resolved to no addresses`,
    };
  }

  return {
    ok: true,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
    hostname,
    port,
    url,
  };
}

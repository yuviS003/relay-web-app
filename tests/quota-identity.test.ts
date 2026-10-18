import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normaliseAddress,
  parseForwardedFor,
  resolveClientIdentity,
  SHARED_BUCKET_KEY,
  trustedProxyHops,
} from '../src/lib/net/client-ip';
import {
  __resetQuota,
  AUTH_POLICY,
  isUsableQuotaUrl,
  consumeQuota,
  GUEST_RELAY_POLICY,
  quotaBackend,
  takeToken,
} from '../src/lib/quota';

const ENV_KEYS = [
  'TRUSTED_PROXY_HOPS',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
] as const;
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  __resetQuota();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  vi.unstubAllGlobals();
});

const headers = (init: Record<string, string>) => new Headers(init);

describe('address normalisation', () => {
  it('accepts bare IPv4 and IPv6', () => {
    expect(normaliseAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(normaliseAddress(' 2001:DB8::1 ')).toBe('2001:db8::1');
  });

  it('strips ports, brackets, quotes and IPv6 zones', () => {
    expect(normaliseAddress('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(normaliseAddress('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normaliseAddress('"203.0.113.7"')).toBe('203.0.113.7');
    expect(normaliseAddress('fe80::1%eth0')).toBe('fe80::1');
  });

  it('rejects anything that is not an address', () => {
    // A junk value must not become its own quota bucket.
    for (const bad of ['', '   ', 'unknown', 'not-an-ip', '999.1.1.1', '<script>']) {
      expect(normaliseAddress(bad), bad).toBeNull();
    }
  });

  it('drops invalid entries from a forwarded chain', () => {
    expect(parseForwardedFor('unknown, 203.0.113.7, 198.51.100.4')).toEqual([
      '203.0.113.7',
      '198.51.100.4',
    ]);
    expect(parseForwardedFor(null)).toEqual([]);
  });
});

describe('trusted proxy configuration', () => {
  it('defaults to trusting no forwarded header', () => {
    expect(trustedProxyHops()).toBe(0);
  });

  it('ignores a nonsensical value rather than guessing', () => {
    for (const bad of ['abc', '-1', '2.5', '99', '']) {
      process.env.TRUSTED_PROXY_HOPS = bad;
      expect(trustedProxyHops(), bad).toBe(0);
    }
    process.env.TRUSTED_PROXY_HOPS = '2';
    expect(trustedProxyHops()).toBe(2);
  });
});

describe('client identity', () => {
  it('ignores X-Forwarded-For when no proxy is declared', () => {
    // This is the bypass being closed: a direct caller sets the header itself.
    const identity = resolveClientIdentity(
      headers({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.9' }),
    );
    expect(identity.ip).toBeNull();
    expect(identity.source).toBe('none');
    expect(identity.key).toBe(SHARED_BUCKET_KEY);
  });

  it('gives every unidentified caller the same bucket', () => {
    const first = resolveClientIdentity(headers({ 'x-forwarded-for': '198.51.100.1' }));
    const second = resolveClientIdentity(headers({ 'x-forwarded-for': '198.51.100.2' }));
    // Rotating the header must not earn a fresh allowance.
    expect(first.key).toBe(second.key);
  });

  it('counts a declared chain from the right, not the left', () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const identity = resolveClientIdentity(
      // The client forged the first two entries; the proxy appended the last.
      headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.7' }),
    );
    expect(identity.ip).toBe('203.0.113.7');
    expect(identity.source).toBe('forwarded');
  });

  it('skips exactly as many hops as are declared', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    const identity = resolveClientIdentity(
      headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7, 10.0.0.1' }),
    );
    expect(identity.ip).toBe('203.0.113.7');
  });

  it('falls back to the shared bucket when the chain is shorter than declared', () => {
    process.env.TRUSTED_PROXY_HOPS = '3';
    const identity = resolveClientIdentity(headers({ 'x-forwarded-for': '203.0.113.7' }));
    expect(identity.key).toBe(SHARED_BUCKET_KEY);
  });

  it('prefers a platform header, which the edge overwrites', () => {
    const identity = resolveClientIdentity(
      headers({
        'x-vercel-forwarded-for': '203.0.113.7',
        'x-forwarded-for': '1.1.1.1',
      }),
    );
    expect(identity.ip).toBe('203.0.113.7');
    expect(identity.source).toBe('platform');
    expect(identity.key).toBe('ip:203.0.113.7');
  });
});

describe('quota policies', () => {
  it('limits a guest harder than a signed-in account', () => {
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 40; i += 1) {
      if (takeToken('guest-a', now, GUEST_RELAY_POLICY).allowed) allowed += 1;
    }
    expect(allowed).toBe(GUEST_RELAY_POLICY.capacity);
    expect(GUEST_RELAY_POLICY.capacity).toBeLessThan(100);
  });

  it('throttles sign-in attempts to a low burst', () => {
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 25; i += 1) {
      if (takeToken('auth-a', now, AUTH_POLICY).allowed) allowed += 1;
    }
    expect(allowed).toBe(AUTH_POLICY.capacity);
    expect(takeToken('auth-a', now, AUTH_POLICY).retryAfterMs).toBeGreaterThan(0);
  });
});

describe('shared quota store', () => {
  const redisEnv = () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://quota.upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  };

  it('reports which backend is live', () => {
    expect(quotaBackend()).toBe('memory');
    redisEnv();
    expect(quotaBackend()).toBe('redis');
  });

  it('spends a token through one atomic round trip', async () => {
    redisEnv();
    const fetchMock = vi.fn(async () =>
      // allowed, tokens * 1000
      new Response(JSON.stringify({ result: [1, 28_500] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const decision = await consumeQuota('relay:guest', GUEST_RELAY_POLICY);
    expect(decision).toMatchObject({ allowed: true, remaining: 28, backend: 'redis' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const command = JSON.parse(String(init.body)) as string[];
    // One EVAL, so the read-modify-write cannot interleave with another caller.
    expect(command[0]).toBe('EVAL');
    expect(command[2]).toBe('1');
    expect(command[3]).toBe('wac:quota:relay:guest');
    expect(String(init.headers && (init.headers as Record<string, string>).authorization)).toContain(
      'test-token',
    );
  });

  it('refuses and reports a retry delay when the shared bucket is empty', async () => {
    redisEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ result: [0, 0] }), { status: 200 })),
    );

    const decision = await consumeQuota('relay:guest', GUEST_RELAY_POLICY);
    expect(decision.allowed).toBe(false);
    expect(decision.backend).toBe('redis');
    // 0.5 tokens per second means one token is two seconds away.
    expect(decision.retryAfterMs).toBe(2_000);
  });

  it('falls back to the in-process limiter when the store is unreachable', async () => {
    redisEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    // Still limited, just not globally: an unreachable store must not mean
    // an unlimited relay.
    const decision = await consumeQuota('relay:fallback', GUEST_RELAY_POLICY);
    expect(decision.allowed).toBe(true);
    expect(decision.backend).toBe('memory');
  });

  it('falls back when the store answers with an error or junk', async () => {
    redisEnv();
    for (const payload of [{ error: 'WRONGPASS' }, { result: 'nonsense' }]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
      );
      const decision = await consumeQuota('relay:junk', GUEST_RELAY_POLICY);
      expect(decision.backend).toBe('memory');
    }
  });

  it('uses the in-process limiter when no store is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const decision = await consumeQuota('relay:local', GUEST_RELAY_POLICY);
    expect(decision.backend).toBe('memory');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('shared quota configuration', () => {
  /*
   * The failure this guards against cost every request about two seconds.
   * Upstash's dashboard has several copy buttons, and one of them yields a
   * `redis-cli --tls -u redis://…` command line. Pasted into the REST URL it
   * is non-empty, so the store looked configured, every fetch failed, and the
   * timeout was added to each relayed request — with nothing in the request
   * itself to explain the delay.
   */
  it('accepts a REST URL and rejects what is not one', () => {
    expect(isUsableQuotaUrl('https://modern-cougar-12345.upstash.io')).toBe(true);
    expect(isUsableQuotaUrl('http://localhost:8079')).toBe(true);

    for (const bad of [
      '',
      '   ',
      'modern-cougar-12345.upstash.io',
      'redis://default:token@modern-cougar-12345.upstash.io:6379',
      'redis-cli --tls -u redis://default:token@modern-cougar-12345.upstash.io:6379',
      'rediss://default:token@host:6379',
    ]) {
      expect(isUsableQuotaUrl(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

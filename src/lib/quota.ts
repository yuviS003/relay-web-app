/*
 * Per-caller quota for the relay and the sign-in endpoint.
 *
 * An unmetered relay is free bandwidth and a free scanning engine for whoever
 * finds the URL, and guest access means nobody has to register first. So the
 * cost of abuse is capped before any work happens, including before a
 * pre-request script runs.
 *
 * A token bucket rather than a fixed window: a window boundary lets a caller
 * spend its whole allowance at the end of one window and again at the start of
 * the next, producing double the intended burst in a few milliseconds.
 *
 * Two backends, chosen by configuration:
 *
 *   Redis (UPSTASH_REDIS_REST_URL + _TOKEN) — the real one. The bucket lives
 *   outside the process, so every serverless instance decrements the same
 *   counter and a cold start no longer hands out a fresh allowance. The
 *   read-modify-write runs inside a Lua script, which Redis executes
 *   atomically, so concurrent requests cannot both read the same balance and
 *   each spend it.
 *
 *   Memory — the fallback. Correct for one process, but each instance keeps its
 *   own count and a restart resets it. Fine for local development and honest
 *   for a single-instance deployment; not sufficient for a public one, which is
 *   why `quotaBackend()` is surfaced rather than hidden.
 *
 * The identity counted against comes from lib/net/client-ip.ts, which refuses
 * to trust a forgeable header. A limiter keyed on caller-controlled input is
 * not a limiter.
 */

export type QuotaPolicy = {
  /** Maximum burst. */
  capacity: number;
  /** Sustained rate once the burst is spent. */
  refillPerSecond: number;
};

export type QuotaDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  /** Which backend decided, so the caller can report honestly. */
  backend: 'redis' | 'memory';
};

/** Signed-in relay traffic. */
export const RELAY_POLICY: QuotaPolicy = { capacity: 100, refillPerSecond: 1 };

/**
 * Guest relay traffic. Tighter than a signed-in account on purpose: a guest
 * costs nothing to become, so the per-caller ceiling has to be lower.
 */
export const GUEST_RELAY_POLICY: QuotaPolicy = { capacity: 30, refillPerSecond: 0.5 };

/**
 * Credential attempts. Low and slow, because this endpoint is an online
 * password oracle: scrypt protects the stored hashes, not the form.
 *
 * Not *too* low, though. The bucket is keyed on caller identity, which for an
 * unauthenticated caller is an address, so everyone behind one NAT shares it —
 * and a single person setting up security properly spends several in a row:
 * sign up, enable a second factor, sign out, sign back in with a code, add a
 * passkey, sign in with it. A ceiling tuned only against guessing turned that
 * sequence into "too many attempts" for a legitimate user. Twenty per burst
 * and roughly twenty a minute sustained is still worthless to an attacker,
 * each attempt costing a scrypt verification.
 */
export const AUTH_POLICY: QuotaPolicy = { capacity: 20, refillPerSecond: 0.34 };

const SWEEP_AFTER_MS = 10 * 60 * 1000;
const MAX_TRACKED = 10_000;
/*
 * A quota check sits in front of every relayed request, so its own latency is
 * part of every response time. 600ms is already far longer than a healthy
 * round trip to a REST Redis; past that, answering from the in-process bucket
 * is better than making the user wait to be told they are allowed.
 */
const REDIS_TIMEOUT_MS = 600;

/*
 * How long to stop trying after a failure.
 *
 * Without this, a misconfigured or unreachable store costs the timeout on
 * *every* request: the symptom is an API client where each send takes two
 * seconds and nothing in the request explains why. One slow request, then the
 * local bucket until the window passes.
 */
const REDIS_BREAKER_MS = 30_000;
const BREAKER_KEY = '__wac_quota_breaker__';

type BreakerCache = typeof globalThis & { [BREAKER_KEY]?: number };

function breakerOpenUntil(): number {
  return (globalThis as BreakerCache)[BREAKER_KEY] ?? 0;
}

function openBreaker(now: number): void {
  (globalThis as BreakerCache)[BREAKER_KEY] = now + REDIS_BREAKER_MS;
}

type Bucket = { tokens: number; updatedAt: number };

const BUCKETS_KEY = '__wac_quota__';
type GlobalCache = typeof globalThis & { [BUCKETS_KEY]?: Map<string, Bucket> };

function buckets(): Map<string, Bucket> {
  const scope = globalThis as GlobalCache;
  scope[BUCKETS_KEY] ??= new Map<string, Bucket>();
  return scope[BUCKETS_KEY];
}

/**
 * The shared store's configuration, or null when there isn't a usable one.
 *
 * The URL is parsed, not merely checked for emptiness. Upstash's dashboard
 * offers several copy buttons and one of them is a `redis-cli --tls -u
 * redis://…` command line; pasted into this variable it looks configured,
 * fails every fetch, and silently adds the timeout to every request. A value
 * that is not an http(s) URL is treated as absent and reported once.
 */
export function isUsableQuotaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname !== ''
    );
  } catch {
    return false;
  }
}

let warnedAboutUrl = false;

function redisConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (!isUsableQuotaUrl(url)) {
    if (!warnedAboutUrl) {
      warnedAboutUrl = true;
      console.warn(
        '[quota] UPSTASH_REDIS_REST_URL is not an http(s) URL, so the shared quota store is ignored. Use the REST URL (https://<name>.upstash.io), not the redis-cli connection string.',
      );
    }
    return null;
  }
  return { url: url.replace(/\/+$/, ''), token };
}

/** Whether the quota is shared across instances. Surfaced for the UI and docs. */
export function quotaBackend(): 'redis' | 'memory' {
  return redisConfig() ? 'redis' : 'memory';
}

/*
 * The whole read-modify-write in one round trip, executed atomically by Redis.
 *
 * Doing this as GET then SET from the application would be a race: two
 * concurrent requests both read the same balance, both decide they may
 * proceed, and the bucket is overspent. Returning tokens scaled by 1000 keeps
 * the fractional balance (needed to compute a retry delay) without relying on
 * Lua number formatting.
 */
const BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local stored = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(stored[1])
local ts = tonumber(stored[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = tokens + elapsed * refillPerMs
if tokens > capacity then tokens = capacity end

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, ttl)
return { allowed, math.floor(tokens * 1000) }
`;

function decide(
  tokens: number,
  allowed: boolean,
  policy: QuotaPolicy,
  backend: 'redis' | 'memory',
): QuotaDecision {
  if (allowed) {
    return { allowed: true, remaining: Math.floor(tokens), retryAfterMs: 0, backend };
  }
  const refillPerMs = policy.refillPerSecond / 1000;
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: Math.max(1, Math.ceil((1 - tokens) / refillPerMs)),
    backend,
  };
}

async function consumeFromRedis(
  config: { url: string; token: string },
  key: string,
  policy: QuotaPolicy,
  now: number,
): Promise<QuotaDecision | null> {
  const refillPerMs = policy.refillPerSecond / 1000;
  // Keep a bucket only as long as it would take to refill completely; after
  // that a fresh bucket is indistinguishable from the stored one.
  const ttl = Math.ceil((policy.capacity / policy.refillPerSecond) * 1000) + 1_000;

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        'EVAL',
        BUCKET_SCRIPT,
        '1',
        `wac:quota:${key}`,
        String(policy.capacity),
        String(refillPerMs),
        String(now),
        String(ttl),
      ]),
      // A hung quota store must not hang every relayed request.
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!response.ok) {
      openBreaker(now);
      return null;
    }
    const payload = (await response.json()) as { result?: unknown; error?: unknown };
    if (payload.error || !Array.isArray(payload.result)) return null;

    const [allowedRaw, scaledTokens] = payload.result as [unknown, unknown];
    const allowed = Number(allowedRaw) === 1;
    const tokens = Number(scaledTokens) / 1000;
    if (!Number.isFinite(tokens)) return null;

    return decide(tokens, allowed, policy, 'redis');
  } catch {
    // Network error, timeout or malformed reply. The caller falls back to the
    // in-process limiter so the endpoint stays protected, just not globally.
    openBreaker(now);
    return null;
  }
}

/**
 * Spends one token from the in-process bucket.
 *
 * Exported on its own because it is synchronous and deterministic, which makes
 * the token-bucket behaviour directly testable, and because it is the fallback
 * path when no shared store is configured.
 */
export function takeToken(
  key: string,
  now: number = Date.now(),
  policy: QuotaPolicy = RELAY_POLICY,
): QuotaDecision {
  const store = buckets();

  /*
   * Bound the map. Without this, a caller rotating an identity could create
   * unbounded entries and exhaust memory, turning the protection into the
   * vulnerability.
   */
  if (store.size > MAX_TRACKED) {
    for (const [existing, bucket] of store) {
      if (now - bucket.updatedAt > SWEEP_AFTER_MS) store.delete(existing);
    }
    if (store.size > MAX_TRACKED) store.clear();
  }

  const bucket = store.get(key) ?? { tokens: policy.capacity, updatedAt: now };
  const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
  const tokens = Math.min(
    policy.capacity,
    bucket.tokens + elapsedSeconds * policy.refillPerSecond,
  );

  if (tokens < 1) {
    // The balance is written back but the timestamp advance does not punish a
    // retry: a client that hammers must not push its own recovery further out.
    store.set(key, { tokens, updatedAt: now });
    return decide(tokens, false, policy, 'memory');
  }

  store.set(key, { tokens: tokens - 1, updatedAt: now });
  return decide(tokens - 1, true, policy, 'memory');
}

/**
 * Spends one token against the shared store when one is configured, falling
 * back to the in-process bucket otherwise or when the store is unreachable.
 */
export async function consumeQuota(
  key: string,
  policy: QuotaPolicy = RELAY_POLICY,
  now: number = Date.now(),
): Promise<QuotaDecision> {
  const config = redisConfig();
  // Skipped while the breaker is open: a store that just failed is not worth
  // another timeout on this request.
  if (config && now >= breakerOpenUntil()) {
    const decision = await consumeFromRedis(config, key, policy, now);
    if (decision) return decision;
  }
  return takeToken(key, now, policy);
}

export function __resetQuota(): void {
  buckets().clear();
  (globalThis as BreakerCache)[BREAKER_KEY] = 0;
}

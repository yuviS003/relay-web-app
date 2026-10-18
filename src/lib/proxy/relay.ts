import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';

import { applySetCookies, cookieHeaderFor, EMPTY_JAR, type CookieJar } from '../cookies';
import { guardTarget, type GuardFailure, type GuardOptions } from './guard';

/*
 * Performs the relayed request.
 *
 * The guard decided which address is safe; this module's job is to make sure
 * the connection actually goes there and that a hostile endpoint cannot hurt
 * us once connected. Four protections, each closing a distinct failure:
 *
 *  1. Pinned connection. Node's `lookup` hook is overridden so the socket
 *     connects to the address the guard approved. Handing the hostname to an
 *     HTTP client instead would let it resolve a second time, which is the
 *     DNS rebinding hole the guard exists to close. fetch() cannot do this,
 *     which is why this uses node:http directly.
 *
 *  2. Every redirect is re-guarded. A public URL that answers 302 with
 *     Location: http://169.254.169.254/ defeats any one-time check, so each
 *     hop is validated from scratch and the hop count is capped.
 *
 *  3. Response size cap enforced while streaming. Checking Content-Length is
 *     not enough: it is attacker-supplied and may be absent or lie. Bytes are
 *     counted as they arrive and the socket is destroyed on breach, so an
 *     endless response cannot exhaust a 512 MB instance.
 *
 *  4. A total time budget, not just a connect timeout. A server that sends
 *     one byte per second would satisfy any idle timeout while holding the
 *     connection open indefinitely.
 */

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const TOTAL_TIMEOUT_MS = 15_000;
const ALLOWED_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/*
 * Headers that must never be forwarded from the caller. Hop-by-hop headers
 * describe a single connection and would corrupt ours; Host is derived from
 * the pinned target, not chosen by the caller.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
  'trailer',
  'upgrade',
]);

export type RelayRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
};

export type RelayHop = {
  url: string;
  address: string;
  status: number;
};

export type RelaySuccess = {
  ok: true;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /*
   * Set-Cookie values are kept as the array they arrive as. Joining them with
   * a comma — which is what the flattened header map does — corrupts them,
   * because an Expires date contains a comma of its own. The cookie jar needs
   * them intact.
   */
  setCookies: string[];
  body: string;
  bodyBytes: number;
  truncated: boolean;
  durationMs: number;
  /** Every address actually connected to, for display and for audit. */
  hops: readonly RelayHop[];
};

/**
 * Knobs for one relayed call.
 *
 * `sink` is what makes streaming possible: chunks are handed over as they
 * arrive instead of only at the end, while the size cap and the time budget
 * stay exactly where they were. With `keepBody` false the bytes are counted
 * and forwarded but not retained, so a long-lived stream does not grow the
 * server's heap by its own length.
 */
export type RelayTransport = {
  sink?: ((chunk: Buffer) => void) | undefined;
  keepBody?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
};

export type RelayFailure = {
  ok: false;
  reason:
    | 'blocked'
    | 'method-not-allowed'
    | 'too-many-redirects'
    | 'response-too-large'
    | 'timeout'
    | 'network-error';
  /*
   * Why the guard refused, when `reason` is 'blocked'.
   *
   * The coarse reason alone made every refusal look like an SSRF refusal: a
   * hostname that simply does not resolve was reported with the same
   * explanation as a deliberate private-address block, which told the caller
   * the proxy refuses private ranges when the real problem was a typo. The
   * guard already distinguishes these, so the distinction is carried here
   * rather than discarded.
   */
  cause?: GuardFailure;
  detail: string;
  durationMs: number;
  hops: readonly RelayHop[];
};

export type RelayResult = RelaySuccess | RelayFailure;

function normaliseHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const name = key.trim().toLowerCase();
    if (!name || STRIPPED_REQUEST_HEADERS.has(name)) continue;
    // A newline in a header value is request splitting; drop the header.
    if (/[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

function collectResponseHeaders(message: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers)) {
    if (STRIPPED_RESPONSE_HEADERS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

type SingleHop =
  | { kind: 'response'; message: IncomingMessage; body: Buffer; truncated: boolean }
  | { kind: 'error'; reason: RelayFailure['reason']; detail: string };

/**
 * Produces a DNS lookup function that never performs DNS.
 *
 * Node's HTTPS agent requests `all: true` when automatic address-family
 * selection is enabled. In that mode the callback must receive an array;
 * returning the ordinary (address, family) form makes Node read `undefined`
 * as the address and throw "Invalid IP address: undefined". HTTP did not take
 * that path in the local suite, which is why only a real HTTPS smoke test found
 * it.
 */
export function createPinnedLookup(
  address: string,
  family: 4 | 6,
): LookupFunction {
  return ((_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  }) as LookupFunction;
}

/** Issues one request to a pinned address and buffers a capped response. */
function performHop(
  target: { url: URL; address: string; hostname: string; port: number; family: 4 | 6 },
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  deadline: number,
  transport: RelayTransport = {},
): Promise<SingleHop> {
  const maxBytes = transport.maxBytes ?? MAX_RESPONSE_BYTES;
  const keepBody = transport.keepBody !== false;
  return new Promise((resolve) => {
    const isHttps = target.url.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;
    let settled = false;

    const finish = (value: SingleHop) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      finish({ kind: 'error', reason: 'timeout', detail: 'Time budget exhausted' });
      return;
    }

    const clientRequest = send(
      {
        protocol: target.url.protocol,
        // Host header and TLS SNI follow the hostname so virtual hosting and
        // certificate validation still work...
        host: target.hostname,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method,
        headers: { ...headers, host: target.url.host },
        // ...while the socket is forced to the address the guard approved.
        // The pin. Whatever name was requested, the socket connects to the
        // address the guard approved. The lookup implementation handles both
        // Node callback shapes, including HTTPS asking for all addresses.
        lookup: createPinnedLookup(target.address, target.family),
        timeout: remaining,
      },
      (message) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;

        message.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            /*
             * Enforced on the stream, not on Content-Length, which the server
             * controls and may omit entirely.
             *
             * Settled here rather than by waiting for a later event:
             * destroying an IncomingMessage emits 'close', not 'end' or
             * 'error', so deferring the decision left the promise pending
             * forever. A proxy that hangs on an oversized response is worse
             * than one that allows it.
             */
            truncated = true;
            message.destroy();
            clientRequest.destroy();
            finish({
              kind: 'response',
              message,
              body: Buffer.concat(chunks),
              truncated: true,
            });
            return;
          }
          // Forwarded first so a streaming caller sees the bytes now, then
          // retained only if someone is going to read the whole body later.
          transport.sink?.(chunk);
          if (keepBody) chunks.push(chunk);
        });

        message.on('end', () => {
          finish({
            kind: 'response',
            message,
            body: Buffer.concat(chunks),
            truncated,
          });
        });

        message.on('error', () => {
          finish({
            kind: 'error',
            reason: 'network-error',
            detail: 'Connection failed while reading the response',
          });
        });

        // Safety net: if the stream closes without end or error, the promise
        // would otherwise never settle. finish() ignores later calls, so
        // whichever event arrives first decides the outcome.
        message.on('close', () => {
          finish({
            kind: 'error',
            reason: 'network-error',
            detail: 'Connection closed before the response completed',
          });
        });
      },
    );

    clientRequest.on('timeout', () => {
      clientRequest.destroy();
      finish({ kind: 'error', reason: 'timeout', detail: 'Request timed out' });
    });

    clientRequest.on('error', (error: Error) => {
      finish({
        kind: 'error',
        reason: 'network-error',
        detail: error.message,
      });
    });

    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      clientRequest.write(body);
    }
    clientRequest.end();
  });
}

export async function relay(
  input: RelayRequest,
  options: GuardOptions = {},
  transport: RelayTransport = {},
): Promise<RelayResult> {
  const startedAt = Date.now();
  const deadline = startedAt + (transport.timeoutMs ?? TOTAL_TIMEOUT_MS);
  const hops: RelayHop[] = [];

  const method = input.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return {
      ok: false,
      reason: 'method-not-allowed',
      detail: `${method} is not permitted`,
      durationMs: 0,
      hops,
    };
  }

  const headers = normaliseHeaders(input.headers);
  let currentUrl = input.url;
  let currentMethod = method;
  let currentBody = input.body;

  /*
   * Cookies across a redirect chain.
   *
   * A sign-in that answers 302 and sets the session cookie on that response is
   * the commonest cookie flow there is, so returning only the last hop's
   * Set-Cookie loses exactly the cookie that mattered. Every hop's headers are
   * collected, and a hop's cookies are offered to the next one — scoped by the
   * same domain, path and Secure rules as the caller's jar, since this uses
   * the same module.
   */
  const collectedSetCookies: string[] = [];
  let inFlightJar: CookieJar = EMPTY_JAR;
  const callerCookie = headers.cookie;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Re-guarded on every hop. A one-time check is defeated by a public URL
    // that redirects to a private address.
    const guarded = await guardTarget(currentUrl, options);
    if (!guarded.ok) {
      return {
        ok: false,
        reason: 'blocked',
        cause: guarded.reason,
        detail: guarded.detail,
        durationMs: Date.now() - startedAt,
        hops,
      };
    }

    const hopCookie = cookieHeaderFor(inFlightJar, currentUrl);
    const hopHeaders = { ...headers };
    if (hopCookie !== '') {
      hopHeaders.cookie =
        callerCookie && callerCookie !== '' ? `${callerCookie}; ${hopCookie}` : hopCookie;
    }

    const result = await performHop(
      guarded,
      currentMethod,
      hopHeaders,
      currentBody,
      deadline,
      transport,
    );

    if (result.kind === 'error') {
      hops.push({ url: currentUrl, address: guarded.address, status: 0 });
      return {
        ok: false,
        reason: result.reason,
        detail: result.detail,
        durationMs: Date.now() - startedAt,
        hops,
      };
    }

    const status = result.message.statusCode ?? 0;
    hops.push({ url: currentUrl, address: guarded.address, status });

    const hopSetCookie = result.message.headers['set-cookie'];
    if (Array.isArray(hopSetCookie)) collectedSetCookies.push(...hopSetCookie);
    else if (typeof hopSetCookie === 'string') collectedSetCookies.push(hopSetCookie);
    if (collectedSetCookies.length > 0) {
      inFlightJar = applySetCookies(
        inFlightJar,
        Array.isArray(hopSetCookie)
          ? hopSetCookie
          : typeof hopSetCookie === 'string'
            ? [hopSetCookie]
            : [],
        currentUrl,
      );
    }

    const location = result.message.headers.location;
    const isRedirect = status >= 300 && status < 400 && typeof location === 'string';

    if (!isRedirect) {
      if (result.truncated) {
        return {
          ok: false,
          reason: 'response-too-large',
          detail: `Response exceeded ${transport.maxBytes ?? MAX_RESPONSE_BYTES} bytes`,
          durationMs: Date.now() - startedAt,
          hops,
        };
      }

      return {
        ok: true,
        status,
        statusText: result.message.statusMessage ?? '',
        headers: collectResponseHeaders(result.message),
        // Every hop's cookies, not just the last one's.
        setCookies: collectedSetCookies,
        body: result.body.toString('utf8'),
        bodyBytes: result.body.length,
        truncated: false,
        durationMs: Date.now() - startedAt,
        hops,
      };
    }

    if (hop === MAX_REDIRECTS) {
      return {
        ok: false,
        reason: 'too-many-redirects',
        detail: `Exceeded ${MAX_REDIRECTS} redirects`,
        durationMs: Date.now() - startedAt,
        hops,
      };
    }

    // Relative Location values are legal, so resolve against the current URL.
    currentUrl = new URL(location, guarded.url).toString();

    // 303, and 301/302 in practice, turn the follow-up into a GET without a
    // body. Replaying a POST body to a redirect target is how a redirect
    // becomes an unintended write.
    if (status === 303 || status === 301 || status === 302) {
      currentMethod = currentMethod === 'HEAD' ? 'HEAD' : 'GET';
      currentBody = undefined;
    }
  }

  return {
    ok: false,
    reason: 'too-many-redirects',
    detail: `Exceeded ${MAX_REDIRECTS} redirects`,
    durationMs: Date.now() - startedAt,
    hops,
  };
}

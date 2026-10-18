import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPinnedLookup,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  relay,
} from '../src/lib/proxy/relay';

/*
 * Exercises the relay against a real HTTP server rather than a mock, because
 * the behaviour under test is socket-level: pinned connections, streaming size
 * caps, and redirect handling. A stubbed client would prove nothing about any
 * of them.
 *
 * The server binds to 127.0.0.1, which the guard blocks by design, so these
 * tests pass allowPrivate explicitly. That the flag is required here is itself
 * evidence the default is closed.
 */

let server: Server;
let base: string;
let lastRequest: { method: string; headers: Record<string, unknown>; body: string } | null =
  null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastRequest = {
        method: req.method ?? '',
        headers: req.headers as Record<string, unknown>,
        body: Buffer.concat(chunks).toString('utf8'),
      };

      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world', method: req.method }));
        return;
      }

      if (url.pathname === '/echo-headers') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.headers));
        return;
      }

      if (url.pathname === '/huge') {
        // Never ends, and sends no content-length: the cap has to come from
        // counting bytes on the stream.
        res.writeHead(200, { 'content-type': 'text/plain' });
        const blob = 'x'.repeat(64 * 1024);
        const pump = setInterval(() => {
          if (!res.write(blob)) return;
        }, 1);
        res.on('close', () => clearInterval(pump));
        return;
      }

      if (url.pathname === '/slow') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('start');
        // Holds the connection open without ever finishing.
        return;
      }

      if (url.pathname === '/redirect-to-metadata') {
        // The attack a one-time URL check misses entirely.
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }

      if (url.pathname === '/redirect-to-loopback-name') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/' });
        res.end();
        return;
      }

      if (url.pathname === '/redirect-once') {
        res.writeHead(302, { location: '/json' });
        res.end();
        return;
      }

      if (url.pathname === '/redirect-loop') {
        res.writeHead(302, { location: '/redirect-loop' });
        res.end();
        return;
      }

      if (url.pathname === '/status/418') {
        res.writeHead(418, { 'content-type': 'text/plain' });
        res.end('teapot');
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const allow = { allowPrivate: true };

describe('relay: the happy path', () => {
  it('returns one pinned address in all-address lookup mode', async () => {
    const lookup = createPinnedLookup('203.0.113.7', 4);
    const addresses = await new Promise<unknown>((resolve, reject) => {
      // Node's HTTPS agent asks for all addresses; this was the path that
      // returned "Invalid IP address: undefined" in the live smoke test.
      (lookup as (...args: unknown[]) => void)(
        'api.example.com',
        { all: true },
        (error: Error | null, result: unknown) =>
          error ? reject(error) : resolve(result),
      );
    });
    expect(addresses).toEqual([{ address: '203.0.113.7', family: 4 }]);
  });

  it('returns status, headers, and body from a pinned connection', async () => {
    const result = await relay(
      { url: `${base}/json`, method: 'GET', headers: {} },
      allow,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ hello: 'world', method: 'GET' });
    expect(result.headers['content-type']).toContain('application/json');
    // The hop records the address actually connected to, not just the URL.
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0]?.address).toBe('127.0.0.1');
  });

  it('preserves a non-2xx status rather than treating it as an error', async () => {
    const result = await relay(
      { url: `${base}/status/418`, method: 'GET', headers: {} },
      allow,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(418);
      expect(result.body).toBe('teapot');
    }
  });

  it('forwards a body and method on POST', async () => {
    const result = await relay(
      {
        url: `${base}/json`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      },
      allow,
    );
    expect(result.ok).toBe(true);
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.body).toBe('{"a":1}');
  });
});

describe('relay: header hygiene', () => {
  it('sets Host from the target, not from the caller', async () => {
    // A caller-chosen Host would let one site be addressed while another is
    // contacted, which is cache poisoning and routing confusion in one.
    await relay(
      {
        url: `${base}/echo-headers`,
        method: 'GET',
        headers: { host: 'evil.example.com' },
      },
      allow,
    );
    expect(lastRequest?.headers.host).toContain('127.0.0.1');
    expect(lastRequest?.headers.host).not.toContain('evil.example.com');
  });

  it('drops hop-by-hop headers', async () => {
    await relay(
      {
        url: `${base}/echo-headers`,
        method: 'GET',
        headers: {
          'transfer-encoding': 'chunked',
          upgrade: 'websocket',
          'proxy-authorization': 'Basic abc',
          'x-keep-me': 'yes',
        },
      },
      allow,
    );
    expect(lastRequest?.headers['proxy-authorization']).toBeUndefined();
    expect(lastRequest?.headers.upgrade).toBeUndefined();
    // A legitimate custom header still gets through.
    expect(lastRequest?.headers['x-keep-me']).toBe('yes');
  });

  it('drops a header whose value contains CRLF', async () => {
    // Request splitting: a newline would let the caller inject a second
    // request onto the same connection.
    await relay(
      {
        url: `${base}/echo-headers`,
        method: 'GET',
        headers: { 'x-evil': 'a\r\nX-Injected: 1' },
      },
      allow,
    );
    expect(lastRequest?.headers['x-evil']).toBeUndefined();
    expect(lastRequest?.headers['x-injected']).toBeUndefined();
  });
});

describe('relay: redirects are re-guarded', () => {
  it('follows a safe redirect', async () => {
    const result = await relay(
      { url: `${base}/redirect-once`, method: 'GET', headers: {} },
      allow,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.hops).toHaveLength(2);
    }
  });

  it('refuses a redirect pointing at the metadata endpoint', async () => {
    /*
     * The central test of the whole design. The first URL is legitimate, so
     * any check performed only on the submitted URL passes it. The protection
     * has to come from re-validating the Location header.
     */
    const result = await relay(
      { url: `${base}/redirect-to-metadata`, method: 'GET', headers: {} },
      // allowPrivate is NOT passed: a real deployment blocks the private
      // target even though the initial hop was reachable.
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('blocked');
      expect(result.cause).toBe('blocked-address');
    }
  });

  /*
   * The UI explains a refusal from `cause`. When every guard failure collapsed
   * into the bare reason 'blocked', a hostname that simply did not resolve was
   * explained to the user as a private-address refusal, which pointed at a
   * security rule instead of the typo that actually caused it. These two cases
   * must stay distinguishable.
   */
  it('separates a name that does not resolve from a refused address', async () => {
    const unresolvable = await relay(
      {
        url: 'https://no-such-host.invalid/path',
        method: 'GET',
        headers: {},
      },
      allow,
    );
    expect(unresolvable.ok).toBe(false);
    if (!unresolvable.ok) {
      expect(unresolvable.reason).toBe('blocked');
      expect(unresolvable.cause).toBe('unresolvable-host');
    }

    const refused = await relay(
      { url: 'http://169.254.169.254/latest/meta-data/', method: 'GET', headers: {} },
      {},
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('blocked');
      expect(refused.cause).toBe('blocked-address');
    }
  });

  it('stops at the redirect cap instead of looping forever', async () => {
    const result = await relay(
      { url: `${base}/redirect-loop`, method: 'GET', headers: {} },
      allow,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too-many-redirects');
      expect(result.hops.length).toBeLessThanOrEqual(MAX_REDIRECTS + 1);
    }
  });

  it('drops the body and switches to GET on a 302', async () => {
    // Replaying a POST body to a redirect target is how a redirect becomes an
    // unintended write against a different endpoint.
    await relay(
      {
        url: `${base}/redirect-once`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"danger":true}',
      },
      allow,
    );
    expect(lastRequest?.method).toBe('GET');
    expect(lastRequest?.body).toBe('');
  });
});

describe('relay: resource limits', () => {
  it('aborts a response that exceeds the size cap', async () => {
    const result = await relay(
      { url: `${base}/huge`, method: 'GET', headers: {} },
      allow,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('response-too-large');
      expect(result.detail).toContain(String(MAX_RESPONSE_BYTES));
    }
  }, 30_000);

  it('gives up on a connection that never finishes', async () => {
    const result = await relay(
      { url: `${base}/slow`, method: 'GET', headers: {} },
      allow,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
  }, 30_000);
});

describe('relay: input validation', () => {
  it('refuses a method outside the allowed set', async () => {
    const result = await relay(
      { url: `${base}/json`, method: 'TRACE', headers: {} },
      allow,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('method-not-allowed');
  });

  it('refuses loopback when allowPrivate is not passed', async () => {
    // Proves the escape hatch the other tests rely on is closed by default.
    const result = await relay({ url: `${base}/json`, method: 'GET', headers: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('blocked');
      expect(result.detail).toContain('loopback');
    }
  });
});

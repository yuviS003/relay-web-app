import { describe, expect, it } from 'vitest';

import {
  applySetCookies,
  cookieHeaderFor,
  parseSetCookie,
  pruneJar,
  removeCookie,
  EMPTY_JAR,
} from '../src/lib/cookies';
import { amzDate, signAwsV4 } from '../src/lib/signing/sigv4';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

describe('parseSetCookie', () => {
  it('defaults the domain to the host and the path to the directory', () => {
    const cookie = parseSetCookie('sid=abc', 'https://api.example.com/v1/items', NOW);
    expect(cookie).toMatchObject({
      name: 'sid',
      value: 'abc',
      domain: 'api.example.com',
      hostOnly: true,
      path: '/v1',
      secure: false,
      expiresAt: null,
    });
  });

  it('reads the attributes it enforces', () => {
    const cookie = parseSetCookie(
      'sid=abc; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=60',
      'https://api.example.com/v1',
      NOW,
    );
    expect(cookie).toMatchObject({
      domain: 'example.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'none',
      expiresAt: NOW + 60_000,
    });
  });

  it('prefers Max-Age over Expires, as the RFC requires', () => {
    const cookie = parseSetCookie(
      'a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Max-Age=10',
      'https://example.com/',
      NOW,
    );
    expect(cookie?.expiresAt).toBe(NOW + 10_000);
  });

  it('refuses a domain that does not cover the host, or a bare suffix', () => {
    const foreign = parseSetCookie(
      'a=1; Domain=evil.test',
      'https://example.com/',
      NOW,
    );
    expect(foreign?.domain).toBe('example.com');
    expect(foreign?.hostOnly).toBe(true);

    const suffix = parseSetCookie('a=1; Domain=com', 'https://example.com/', NOW);
    expect(suffix?.domain).toBe('example.com');
    expect(suffix?.hostOnly).toBe(true);
  });

  it('rejects a header that is not a cookie', () => {
    expect(parseSetCookie('novalue', 'https://example.com/', NOW)).toBeNull();
    expect(parseSetCookie('=1', 'https://example.com/', NOW)).toBeNull();
    expect(parseSetCookie('a=1', 'not a url', NOW)).toBeNull();
  });
});

describe('cookie jar', () => {
  const jar = applySetCookies(
    EMPTY_JAR,
    [
      'session=top; Domain=example.com; Path=/; Secure',
      'scoped=deep; Path=/v1/items',
      'plain=yes',
    ],
    'https://api.example.com/v1/items/9',
    NOW,
  );

  it('returns cookies whose domain and path cover the request, most specific first', () => {
    // scoped and plain both sit at /v1/items; session is at / and comes last.
    expect(cookieHeaderFor(jar, 'https://api.example.com/v1/items/9', NOW)).toBe(
      'scoped=deep; plain=yes; session=top',
    );
  });

  it('withholds a cookie from a path it does not cover', () => {
    // plain defaulted to the /v1/items directory it was set from.
    expect(cookieHeaderFor(jar, 'https://api.example.com/other', NOW)).toBe(
      'session=top',
    );
  });

  it('withholds a host-only cookie from a sibling host', () => {
    expect(cookieHeaderFor(jar, 'https://other.example.com/v1/items/9', NOW)).toBe(
      'session=top',
    );
  });

  it('never sends a Secure cookie over plain http', () => {
    expect(cookieHeaderFor(jar, 'http://api.example.com/v1/items/9', NOW)).toBe(
      'scoped=deep; plain=yes',
    );
  });

  it('sends nothing to an unrelated host', () => {
    expect(cookieHeaderFor(jar, 'https://example.org/', NOW)).toBe('');
  });

  it('replaces a cookie with the same name, domain and path', () => {
    const updated = applySetCookies(jar, ['plain=changed'], 'https://api.example.com/v1/items/9', NOW);
    expect(cookieHeaderFor(updated, 'https://api.example.com/v1/items/9', NOW)).toContain(
      'plain=changed',
    );
    expect(updated.filter((cookie) => cookie.name === 'plain')).toHaveLength(1);
  });

  it('treats an expiry in the past as a deletion', () => {
    const cleared = applySetCookies(
      jar,
      ['plain=; Max-Age=0'],
      'https://api.example.com/v1/items/9',
      NOW,
    );
    expect(cookieHeaderFor(cleared, 'https://api.example.com/v1/items/9', NOW)).not.toContain(
      'plain=',
    );
  });

  it('stops returning a cookie once it has expired', () => {
    const shortLived = applySetCookies(
      EMPTY_JAR,
      ['temp=1; Max-Age=30'],
      'https://example.com/',
      NOW,
    );
    expect(cookieHeaderFor(shortLived, 'https://example.com/', NOW + 10_000)).toBe('temp=1');
    expect(cookieHeaderFor(shortLived, 'https://example.com/', NOW + 60_000)).toBe('');
    expect(pruneJar(shortLived, NOW + 60_000)).toHaveLength(0);
  });

  it('removes a named cookie on request', () => {
    const smaller = removeCookie(jar, 'session', 'example.com', '/');
    expect(smaller.some((cookie) => cookie.name === 'session')).toBe(false);
  });

  it('is immutable: applying returns a new jar', () => {
    const before = [...jar];
    applySetCookies(jar, ['x=1'], 'https://api.example.com/', NOW);
    expect(jar).toEqual(before);
  });
});

describe('AWS Signature Version 4', () => {
  /*
   * The published "get-vanilla" case from the AWS SigV4 test suite. Matching
   * it byte for byte is the only way to know the implementation is right; a
   * self-consistent signature proves nothing.
   */
  const vector = {
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: {},
    body: '',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
    at: new Date('2015-08-30T12:36:00Z'),
  };

  it('builds the canonical request the specification shows', () => {
    const signed = signAwsV4(vector);
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-content-sha256;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
  });

  it('signs the vector to a stable, verifiable signature', () => {
    const signed = signAwsV4(vector);
    expect(signed.stringToSign.startsWith('AWS4-HMAC-SHA256\n20150830T123600Z\n')).toBe(
      true,
    );
    expect(signed.stringToSign).toContain('20150830/us-east-1/service/aws4_request');
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.headers.authorization).toContain(
      'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request',
    );
    expect(signed.headers.authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date',
    );
    expect(signed.headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('changes the signature when anything signed changes', () => {
    const base = signAwsV4(vector).signature;
    expect(signAwsV4({ ...vector, method: 'POST' }).signature).not.toBe(base);
    expect(signAwsV4({ ...vector, body: '{"a":1}' }).signature).not.toBe(base);
    expect(signAwsV4({ ...vector, region: 'eu-west-1' }).signature).not.toBe(base);
    expect(
      signAwsV4({ ...vector, url: 'https://example.amazonaws.com/?b=2&a=1' }).signature,
    ).not.toBe(base);
  });

  it('sorts the query string by encoded name and value', () => {
    const signed = signAwsV4({
      ...vector,
      url: 'https://example.amazonaws.com/?b=2&a=1&a=0&c=hello%20world',
    });
    expect(signed.canonicalRequest.split('\n')[2]).toBe('a=0&a=1&b=2&c=hello%20world');
  });

  it('signs a session token when one is supplied', () => {
    const signed = signAwsV4({ ...vector, sessionToken: 'session-token' });
    expect(signed.canonicalRequest).toContain('x-amz-security-token:session-token');
    expect(signed.headers['x-amz-security-token']).toBe('session-token');
  });

  it('leaves volatile headers out of the signature', () => {
    const signed = signAwsV4({
      ...vector,
      headers: { 'user-agent': 'relay', 'content-length': '0', 'x-custom': 'keep' },
    });
    expect(signed.canonicalRequest).toContain('x-custom:keep');
    expect(signed.canonicalRequest).not.toContain('user-agent');
    expect(signed.canonicalRequest).not.toContain('content-length');
  });

  it('formats the AMZ timestamp the way the service expects', () => {
    expect(amzDate(new Date('2026-02-03T04:05:06.789Z'))).toEqual({
      stamp: '20260203T040506Z',
      date: '20260203',
    });
  });
});

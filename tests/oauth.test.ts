import { afterEach, describe, expect, it } from 'vitest';

import {
  authorizationUrl,
  callbackUrl,
  clearedOAuthStateCookie,
  configuredAppOrigin,
  createOAuthState,
  describeRedirectMismatch,
  isOAuthProvider,
  oauthAvailability,
  oauthStateCookie,
  readOAuthState,
  requestOrigin,
} from '../src/lib/auth/oauth';

const original = {
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_CLIENT_SECRET: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  // Controlled explicitly: the suite loads .env, so a developer's own value
  // would otherwise decide what the callback URL assertions see.
  APP_URL: process.env.APP_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('OAuth configuration and state', () => {
  it('recognises only supported providers', () => {
    expect(isOAuthProvider('google')).toBe(true);
    expect(isOAuthProvider('github')).toBe(true);
    expect(isOAuthProvider('evil')).toBe(false);
  });

  it('creates a provider-bound, HttpOnly state cookie', () => {
    const state = createOAuthState('google');
    expect(state).toMatch(/^google\.[A-Za-z0-9_-]+$/);
    const cookie = oauthStateCookie(state, true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(readOAuthState(`other=1; ${cookie.split(';')[0]}`)).toBe(state);
    expect(clearedOAuthStateCookie(false)).toContain('Max-Age=0');
  });

  it('exposes availability only when both values exist', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id';
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    expect(oauthAvailability().google).toBe(false);
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    expect(oauthAvailability().google).toBe(true);
  });

  it('prefers a configured APP_URL for the callback, whatever the request says', () => {
    // In production the redirect URI must match what is registered with the
    // provider, so an explicit origin wins over forwarded headers.
    process.env.APP_URL = 'https://relay.example.com';
    const request = new Request('http://internal:3000/api/auth/oauth/github', {
      headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example' },
    });
    expect(callbackUrl(request, 'github')).toBe(
      'https://relay.example.com/api/auth/oauth/github/callback',
    );
  });

  it('builds callback and authorization URLs without trusting query input', () => {
    delete process.env.APP_URL;
    const request = new Request('http://internal:3000/api/auth/oauth/google', {
      headers: { host: 'relay.example.com', 'x-forwarded-proto': 'https' },
    });
    const redirect = callbackUrl(request, 'google');
    expect(redirect).toBe('https://relay.example.com/api/auth/oauth/google/callback');
    const auth = new URL(
      authorizationUrl(
        'google',
        {
          clientId: 'client', clientSecret: 'secret',
          authorizeUrl: 'https://accounts.example/authorize',
          tokenUrl: 'https://accounts.example/token', scope: 'openid email',
        },
        redirect,
        'google.state',
      ),
    );
    expect(auth.searchParams.get('client_id')).toBe('client');
    expect(auth.searchParams.get('redirect_uri')).toBe(redirect);
    expect(auth.searchParams.get('state')).toBe('google.state');
  });
});

describe('redirect URI diagnostics', () => {
  const request = (headers: Record<string, string>) =>
    new Request('http://localhost:3000/api/auth/oauth/google', { headers });

  it('reads the origin the request actually arrived on', () => {
    expect(requestOrigin(request({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
    expect(
      requestOrigin(
        request({ host: 'internal', 'x-forwarded-host': 'relay.example.com', 'x-forwarded-proto': 'https' }),
      ),
    ).toBe('https://relay.example.com');
  });

  it('stays quiet when APP_URL is unset or already matches', () => {
    delete process.env.APP_URL;
    expect(
      describeRedirectMismatch(request({ host: 'localhost:3000' }), 'http://localhost:3000/cb'),
    ).toBeNull();

    process.env.APP_URL = 'http://localhost:3000';
    expect(
      describeRedirectMismatch(request({ host: 'localhost:3000' }), 'http://localhost:3000/cb'),
    ).toBeNull();
  });

  it('names both origins when the configured one cannot work', () => {
    // The exact failure seen in development: APP_URL on one port, the dev
    // server on another, so the provider rejects the redirect_uri.
    process.env.APP_URL = 'http://localhost:3007';
    const message = describeRedirectMismatch(
      request({ host: 'localhost:3000' }),
      'http://localhost:3007/api/auth/oauth/google/callback',
    );
    expect(message).toContain('http://localhost:3007');
    expect(message).toContain('http://localhost:3000');
    expect(message).toContain('rejected');
  });

  it('reports an APP_URL that is not a usable origin', () => {
    // `new URL('localhost:3000')` parses as a "localhost:" scheme rather than
    // throwing, so a missing scheme has to be rejected explicitly.
    for (const bad of ['localhost:3000', 'relay.example.com', 'ftp://relay.example.com', '://x']) {
      process.env.APP_URL = bad;
      expect(configuredAppOrigin(), bad).toBeNull();
      const message = describeRedirectMismatch(request({ host: 'localhost:3000' }), 'x');
      expect(message, bad).toContain('not a valid URL');
      expect(message, bad).toContain('http://');
      // And it must never leak into the redirect_uri we build.
      expect(callbackUrl(request({ host: 'localhost:3000' }), 'google')).toBe(
        'http://localhost:3000/api/auth/oauth/google/callback',
      );
    }
  });

  it('accepts a well-formed origin, ignoring any path on it', () => {
    process.env.APP_URL = 'https://relay.example.com/ignored/path';
    expect(configuredAppOrigin()).toBe('https://relay.example.com');
    expect(callbackUrl(request({ host: 'localhost:3000' }), 'github')).toBe(
      'https://relay.example.com/api/auth/oauth/github/callback',
    );
  });
});

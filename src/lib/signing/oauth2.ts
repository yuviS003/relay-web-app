/*
 * OAuth 2 token acquisition, for the two grants a request client needs.
 *
 * client_credentials and refresh_token only. The authorization_code grant
 * needs a browser redirect and a registered callback, which the app already
 * does for signing *into* Relay; doing it for arbitrary third-party APIs would
 * mean asking every user to register this deployment with every provider.
 *
 * The token request is sent through the same guarded relay as everything else:
 * a token endpoint is a URL from a saved request, so it gets the SSRF guard,
 * the caps and the redirect re-validation too. No exceptions for "our own"
 * requests — that is how the one unguarded path appears.
 */

export type OAuth2Config = {
  grant: 'client_credentials' | 'refresh_token';
  tokenUrl: string;
  clientId: string;
  clientSecret?: string | undefined;
  /** Required for refresh_token. */
  refreshToken?: string | undefined;
  scope?: string | undefined;
  audience?: string | undefined;
  /** How the client authenticates: a Basic header or body parameters. */
  clientAuth?: 'basic' | 'body' | undefined;
};

export type TokenRequest = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
};

export type AccessToken = {
  accessToken: string;
  tokenType: string;
  /** Epoch milliseconds, or null when the response did not say. */
  expiresAt: number | null;
  refreshToken: string | null;
  scope: string | null;
};

export class OAuth2Error extends Error {}

export function buildTokenRequest(config: OAuth2Config): TokenRequest {
  if (!config.tokenUrl || !/^https?:\/\//i.test(config.tokenUrl)) {
    throw new OAuth2Error('A full http(s) token URL is required');
  }
  if (!config.clientId) throw new OAuth2Error('A client id is required');
  if (config.grant === 'refresh_token' && !config.refreshToken) {
    throw new OAuth2Error('A refresh token is required for the refresh_token grant');
  }

  const form = new URLSearchParams({ grant_type: config.grant });
  if (config.scope) form.set('scope', config.scope);
  if (config.audience) form.set('audience', config.audience);
  if (config.grant === 'refresh_token') {
    form.set('refresh_token', config.refreshToken ?? '');
  }

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };

  const style = config.clientAuth ?? (config.clientSecret ? 'basic' : 'body');
  if (style === 'basic' && config.clientSecret) {
    // RFC 6749 §2.3.1: the credentials are form-encoded before base64, which
    // matters for secrets containing '+' or ':'.
    const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(
      config.clientSecret,
    )}`;
    headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  } else {
    form.set('client_id', config.clientId);
    if (config.clientSecret) form.set('client_secret', config.clientSecret);
  }

  return { url: config.tokenUrl, method: 'POST', headers, body: form.toString() };
}

export function parseTokenResponse(
  payload: unknown,
  now = Date.now(),
): AccessToken {
  if (typeof payload === 'string') {
    try {
      return parseTokenResponse(JSON.parse(payload), now);
    } catch {
      throw new OAuth2Error('The token endpoint did not return JSON');
    }
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new OAuth2Error('The token endpoint did not return an object');
  }

  const body = payload as Record<string, unknown>;
  if (typeof body.error === 'string') {
    const description =
      typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
    throw new OAuth2Error(`${body.error}${description}`);
  }

  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new OAuth2Error('The token endpoint returned no access_token');
  }

  const expiresIn = Number(body.expires_in);
  return {
    accessToken,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}

export function authorizationHeader(token: AccessToken): string {
  const type = token.tokenType.toLowerCase() === 'bearer' ? 'Bearer' : token.tokenType;
  return `${type} ${token.accessToken}`;
}

/*
 * A token cache, so a collection run does not fetch a new token for every
 * request. Keyed by everything that changes which token you get, and expiring
 * early by a margin, because a token that expires in flight fails the request
 * it was fetched for.
 */
const EXPIRY_MARGIN_MS = 30_000;
const cache = new Map<string, AccessToken>();

export function cacheKey(config: OAuth2Config): string {
  return [
    config.grant,
    config.tokenUrl,
    config.clientId,
    config.scope ?? '',
    config.audience ?? '',
    config.grant === 'refresh_token' ? (config.refreshToken ?? '') : '',
  ].join('|');
}

export function readCachedToken(
  config: OAuth2Config,
  now = Date.now(),
): AccessToken | null {
  const token = cache.get(cacheKey(config));
  if (!token) return null;
  if (token.expiresAt !== null && token.expiresAt - EXPIRY_MARGIN_MS <= now) {
    cache.delete(cacheKey(config));
    return null;
  }
  return token;
}

export function cacheToken(config: OAuth2Config, token: AccessToken): void {
  cache.set(cacheKey(config), token);
}

export function __clearTokenCache(): void {
  cache.clear();
}

/**
 * Fetches a token, reusing a cached one while it is still valid.
 *
 * `send` is injected so the caller decides how the request travels — in the
 * app that is the guarded relay, and in tests it is a stub.
 */
export async function acquireToken(
  config: OAuth2Config,
  send: (request: TokenRequest) => Promise<{ status: number; body: string }>,
  now: () => number = Date.now,
): Promise<AccessToken> {
  const cached = readCachedToken(config, now());
  if (cached) return cached;

  const request = buildTokenRequest(config);
  const response = await send(request);
  if (response.status >= 400) {
    // The body usually carries the real reason, and OAuth error bodies are
    // small and non-secret.
    let detail = '';
    try {
      const parsed = JSON.parse(response.body) as Record<string, unknown>;
      detail =
        typeof parsed.error === 'string'
          ? `: ${parsed.error}${
              typeof parsed.error_description === 'string'
                ? ` (${parsed.error_description})`
                : ''
            }`
          : '';
    } catch {
      detail = response.body.slice(0, 120) ? `: ${response.body.slice(0, 120)}` : '';
    }
    throw new OAuth2Error(`Token endpoint responded ${response.status}${detail}`);
  }

  const token = parseTokenResponse(response.body, now());
  cacheToken(config, token);
  return token;
}

import { randomBytes } from 'node:crypto';

import type { OAuthProvider } from '@/lib/auth';

export const OAUTH_STATE_COOKIE = 'wac_oauth_state';
const STATE_TTL_SECONDS = 10 * 60;

type ProviderConfig = {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
};

function credentials(provider: OAuthProvider): { clientId: string; clientSecret: string } {
  return provider === 'google'
    ? {
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      }
    : {
        clientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? '',
        clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
      };
}

export function oauthAvailability(): Record<OAuthProvider, boolean> {
  return {
    google: Boolean(
      process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    ),
    github: Boolean(
      process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET,
    ),
  };
}

export function providerConfig(provider: OAuthProvider): ProviderConfig | null {
  const { clientId, clientSecret } = credentials(provider);
  if (!clientId || !clientSecret) return null;
  return provider === 'google'
    ? {
        clientId,
        clientSecret,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scope: 'openid email profile',
      }
    : {
        clientId,
        clientSecret,
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        scope: 'read:user user:email',
      };
}

export function isOAuthProvider(value: string): value is OAuthProvider {
  return value === 'google' || value === 'github';
}

export function createOAuthState(provider: OAuthProvider): string {
  return `${provider}.${randomBytes(24).toString('base64url')}`;
}

export function oauthStateCookie(state: string, secure: boolean): string {
  return [
    `${OAUTH_STATE_COOKIE}=${state}`,
    'Path=/api/auth/oauth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${STATE_TTL_SECONDS}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearedOAuthStateCookie(secure: boolean): string {
  return [
    `${OAUTH_STATE_COOKIE}=`,
    'Path=/api/auth/oauth',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function readOAuthState(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== OAUTH_STATE_COOKIE) continue;
    const value = rest.join('=');
    return /^(google|github)\.[A-Za-z0-9_-]{24,128}$/.test(value) ? value : null;
  }
  return null;
}

/** The origin this request actually arrived on, honouring proxy headers. */
export function requestOrigin(request: Request): string {
  const incoming = new URL(request.url);
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto === 'https' ? 'https:' : incoming.protocol;
  const host = forwardedHost || request.headers.get('host') || incoming.host;
  return `${protocol}//${host}`;
}

/**
 * APP_URL as a usable http(s) origin, or null when unset or unusable.
 *
 * The protocol check is not redundant: `new URL('localhost:3000')` does not
 * throw. It parses as a `localhost:` scheme whose origin is the string "null",
 * so a value missing its scheme — the common mistake — would otherwise sail
 * through and produce a nonsense redirect_uri that the provider rejects with no
 * explanation.
 */
export function configuredAppOrigin(): string | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function callbackUrl(request: Request, provider: OAuthProvider): string {
  // An unusable APP_URL falls back to the request origin rather than building
  // a redirect_uri that cannot work.
  const base = configuredAppOrigin() ?? requestOrigin(request);
  return new URL(`/api/auth/oauth/${provider}/callback`, base).href;
}

/**
 * Explains a redirect URI that the provider is certain to reject, before the
 * user is sent to a bare "Error 400" page they cannot act on.
 *
 * Both Google and GitHub require the `redirect_uri` to match a registered
 * entry exactly, origin included. When APP_URL names a different origin than
 * the one serving the request, the value sent is wrong for this deployment —
 * and even if it were registered, the provider would hand the user back to an
 * origin that is not running. That is a configuration mistake worth naming.
 */
export function describeRedirectMismatch(
  request: Request,
  redirectUri: string,
): string | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;

  const actual = requestOrigin(request);
  const configuredOrigin = configuredAppOrigin();
  if (!configuredOrigin) {
    return `APP_URL is not a valid URL ("${raw}"). It needs a full http:// or https:// origin, for example ${actual}.`;
  }
  if (configuredOrigin === actual) return null;

  return (
    `APP_URL is ${configuredOrigin} but this request arrived on ${actual}, so the ` +
    `redirect_uri sent to the provider (${redirectUri}) will be rejected. ` +
    `Either set APP_URL to ${actual} — or clear it to use the request origin — ` +
    `and register ${actual}/api/auth/oauth/<provider>/callback with the provider.`
  );
}

export function authorizationUrl(
  provider: OAuthProvider,
  config: ProviderConfig,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  if (provider === 'google') {
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
  }
  return url.href;
}

export type OAuthProfile = { subject: string; email: string };

async function exchangeToken(
  provider: OAuthProvider,
  config: ProviderConfig,
  code: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = (await response.json()) as { access_token?: unknown; error_description?: unknown; error?: unknown };
  if (!response.ok || typeof data.access_token !== 'string') {
    throw new Error(String(data.error_description ?? data.error ?? 'OAuth token exchange failed'));
  }
  return data.access_token;
}

export async function fetchOAuthProfile(
  provider: OAuthProvider,
  config: ProviderConfig,
  code: string,
  redirectUri: string,
): Promise<OAuthProfile> {
  const token = await exchangeToken(provider, config, code, redirectUri);
  if (provider === 'google') {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${token}` },
    });
    const profile = (await response.json()) as {
      sub?: unknown;
      email?: unknown;
      email_verified?: unknown;
    };
    if (
      !response.ok ||
      typeof profile.sub !== 'string' ||
      typeof profile.email !== 'string' ||
      profile.email_verified !== true
    ) {
      throw new Error('Google did not return a verified email address');
    }
    return { subject: profile.sub, email: profile.email };
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'relay-web-api-client',
  };
  const response = await fetch('https://api.github.com/user', { headers });
  const profile = (await response.json()) as { id?: unknown; email?: unknown };
  if (!response.ok || (typeof profile.id !== 'number' && typeof profile.id !== 'string')) {
    throw new Error('GitHub profile could not be loaded');
  }
  const emailsResponse = await fetch('https://api.github.com/user/emails', { headers });
  const emails = (await emailsResponse.json()) as unknown;
  let email: string | null = null;
  if (emailsResponse.ok && Array.isArray(emails)) {
    const verified = emails.find(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as { verified?: unknown }).verified === true &&
        (item as { primary?: unknown }).primary === true,
    ) as { email?: unknown } | undefined;
    if (typeof verified?.email === 'string') email = verified.email;
  }
  if (!email) throw new Error('GitHub did not return a verified primary email address');
  return { subject: String(profile.id), email };
}

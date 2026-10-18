import { acquireToken, authorizationHeader, type OAuth2Config } from './oauth2';
import { signAwsV4 } from './sigv4';

/*
 * Turning a saved auth configuration into headers, on the server, after
 * {{variables}} have been substituted.
 *
 * Deliberately not in the browser. SigV4 signs the exact URL and body that
 * will be sent, and the relay rewrites both during substitution, so a
 * signature computed in the page would never match. The same move keeps the
 * secret access key and the client secret out of page scripts: they arrive in
 * the request to the relay and are used once.
 *
 * Credentials are expected to be written as {{variables}} in the UI, so what
 * is *stored* in a collection is a reference and what is *sent* is resolved
 * from the environment — with secret variables decrypted in the browser, where
 * the passphrase lives.
 */

export type RequestAuth =
  | { kind: 'none' }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'bearer'; token: string }
  | {
      kind: 'sigv4';
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string | undefined;
      region: string;
      service: string;
    }
  | ({ kind: 'oauth2' } & OAuth2Config);

export class AuthError extends Error {}

function text(value: unknown, field: string, required = true): string {
  if (typeof value !== 'string' || value.trim() === '') {
    if (required) throw new AuthError(`auth.${field} is required`);
    return '';
  }
  if (value.length > 4096) throw new AuthError(`auth.${field} is too long`);
  return value;
}

/** Validates the auth block from a relay request body. */
export function parseRequestAuth(input: unknown): RequestAuth {
  if (input === undefined || input === null) return { kind: 'none' };
  if (typeof input !== 'object') throw new AuthError('auth must be an object');

  const value = input as Record<string, unknown>;
  switch (value.kind) {
    case undefined:
    case 'none':
      return { kind: 'none' };
    case 'basic':
      return {
        kind: 'basic',
        username: text(value.username, 'username', false),
        password: text(value.password, 'password', false),
      };
    case 'bearer':
      return { kind: 'bearer', token: text(value.token, 'token') };
    case 'sigv4':
      return {
        kind: 'sigv4',
        accessKeyId: text(value.accessKeyId, 'accessKeyId'),
        secretAccessKey: text(value.secretAccessKey, 'secretAccessKey'),
        sessionToken:
          typeof value.sessionToken === 'string' && value.sessionToken !== ''
            ? value.sessionToken
            : undefined,
        region: text(value.region, 'region'),
        service: text(value.service, 'service'),
      };
    case 'oauth2': {
      const grant = value.grant === 'refresh_token' ? 'refresh_token' : 'client_credentials';
      return {
        kind: 'oauth2',
        grant,
        tokenUrl: text(value.tokenUrl, 'tokenUrl'),
        clientId: text(value.clientId, 'clientId'),
        clientSecret:
          typeof value.clientSecret === 'string' ? value.clientSecret : undefined,
        refreshToken:
          typeof value.refreshToken === 'string' ? value.refreshToken : undefined,
        scope: typeof value.scope === 'string' ? value.scope : undefined,
        audience: typeof value.audience === 'string' ? value.audience : undefined,
        clientAuth: value.clientAuth === 'body' ? 'body' : 'basic',
      };
    }
    default:
      throw new AuthError(`auth.kind "${String(value.kind)}" is not supported`);
  }
}

export type AuthTarget = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * The headers an auth configuration contributes.
 *
 * `fetchToken` is injected rather than called directly so the OAuth token
 * request travels through the caller's guarded relay: a token endpoint is a
 * URL from a saved request like any other, and it gets the same SSRF guard,
 * caps and redirect re-validation.
 */
export async function applyAuth(
  auth: RequestAuth,
  target: AuthTarget,
  fetchToken: (request: {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  }) => Promise<{ status: number; body: string }>,
): Promise<Record<string, string>> {
  switch (auth.kind) {
    case 'none':
      return {};

    case 'basic': {
      const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString(
        'base64',
      );
      return { authorization: `Basic ${credentials}` };
    }

    case 'bearer': {
      // Tolerates a token pasted with the scheme already on it.
      const token = auth.token.trim();
      return {
        authorization: /^bearer\s/i.test(token) ? token : `Bearer ${token}`,
      };
    }

    case 'sigv4': {
      const signed = signAwsV4({
        method: target.method,
        url: target.url,
        headers: target.headers,
        body: target.body,
        accessKeyId: auth.accessKeyId,
        secretAccessKey: auth.secretAccessKey,
        sessionToken: auth.sessionToken,
        region: auth.region,
        service: auth.service,
      });
      return signed.headers;
    }

    case 'oauth2': {
      const token = await acquireToken(auth, fetchToken);
      return { authorization: authorizationHeader(token) };
    }

    default: {
      const exhaustive: never = auth;
      throw new AuthError(`Unhandled auth ${JSON.stringify(exhaustive)}`);
    }
  }
}

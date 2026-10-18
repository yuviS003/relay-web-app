'use client';

import { AUTH_KINDS, type RequestAuthSpec } from '@/lib/store/types';

type AuthEditorProps = {
  auth: RequestAuthSpec;
  onChange: (next: RequestAuthSpec) => void;
};

const LABELS: Record<string, string> = {
  none: 'None',
  basic: 'Basic',
  bearer: 'Bearer token',
  sigv4: 'AWS Signature v4',
  oauth2: 'OAuth 2',
};

/**
 * How this request authenticates.
 *
 * Every field accepts a {{variable}}, which is the intended way to use it: the
 * collection then stores a reference and the value comes from an environment,
 * where secrets are encrypted in the browser. Credentials typed directly here
 * are saved as written, and the hint says so.
 *
 * Nothing is computed in the page. The server applies the scheme after
 * substitution, because a SigV4 signature covers the final URL and body.
 */
export function AuthEditor({ auth, onChange }: AuthEditorProps) {
  const set = (patch: Partial<RequestAuthSpec>): void => onChange({ ...auth, ...patch });

  const field = (
    id: keyof RequestAuthSpec,
    label: string,
    placeholder: string,
    type: 'text' | 'password' = 'text',
  ) => (
    <div className="dialogField" key={id}>
      <label htmlFor={`auth-${id}`}>{label}</label>
      <input
        id={`auth-${id}`}
        type={type}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={(auth[id] as string | undefined) ?? ''}
        onChange={(event) => set({ [id]: event.target.value } as Partial<RequestAuthSpec>)}
      />
    </div>
  );

  return (
    <div className="authEditor">
      <div className="dialogField">
        <label htmlFor="auth-kind">Scheme</label>
        <select
          id="auth-kind"
          value={auth.kind}
          onChange={(event) =>
            set({ kind: event.target.value as RequestAuthSpec['kind'] })
          }
        >
          {AUTH_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {LABELS[kind] ?? kind}
            </option>
          ))}
        </select>
      </div>

      {auth.kind === 'none' ? (
        <p className="hint">
          No credentials are added. Set an <code>authorization</code> header by
          hand if you prefer.
        </p>
      ) : null}

      {auth.kind === 'basic' ? (
        <>
          {field('username', 'Username', '{{api_user}}')}
          {field('password', 'Password', '{{api_password}}', 'password')}
        </>
      ) : null}

      {auth.kind === 'bearer' ? field('token', 'Token', '{{access_token}}') : null}

      {auth.kind === 'sigv4' ? (
        <>
          <div className="authGrid">
            {field('accessKeyId', 'Access key id', '{{aws_access_key_id}}')}
            {field('secretAccessKey', 'Secret access key', '{{aws_secret_access_key}}', 'password')}
            {field('region', 'Region', 'us-east-1')}
            {field('service', 'Service', 's3')}
          </div>
          {field('sessionToken', 'Session token (optional)', '{{aws_session_token}}')}
          <p className="hint">
            Signed on the server, after variables are substituted: the
            signature covers the exact URL and body that will be sent.
          </p>
        </>
      ) : null}

      {auth.kind === 'oauth2' ? (
        <>
          <div className="dialogField">
            <label htmlFor="auth-grant">Grant</label>
            <select
              id="auth-grant"
              value={auth.grant ?? 'client_credentials'}
              onChange={(event) =>
                set({
                  grant:
                    event.target.value === 'refresh_token'
                      ? 'refresh_token'
                      : 'client_credentials',
                })
              }
            >
              <option value="client_credentials">client_credentials</option>
              <option value="refresh_token">refresh_token</option>
            </select>
          </div>
          {field('tokenUrl', 'Token URL', 'https://auth.example.com/oauth/token')}
          <div className="authGrid">
            {field('clientId', 'Client id', '{{client_id}}')}
            {field('clientSecret', 'Client secret', '{{client_secret}}', 'password')}
          </div>
          {auth.grant === 'refresh_token'
            ? field('refreshToken', 'Refresh token', '{{refresh_token}}')
            : null}
          <div className="authGrid">
            {field('scope', 'Scope (optional)', 'read write')}
            {field('audience', 'Audience (optional)', 'https://api.example.com')}
          </div>
          <div className="dialogField">
            <label htmlFor="auth-clientAuth">Client authentication</label>
            <select
              id="auth-clientAuth"
              value={auth.clientAuth ?? 'basic'}
              onChange={(event) =>
                set({ clientAuth: event.target.value === 'body' ? 'body' : 'basic' })
              }
            >
              <option value="basic">Basic header</option>
              <option value="body">Body parameters</option>
            </select>
          </div>
          <p className="hint">
            The token is fetched through the same guarded relay and cached until
            shortly before it expires.
          </p>
        </>
      ) : null}

      {auth.kind !== 'none' ? (
        <p className="hint">
          Values are stored with the request as written. Use{' '}
          <code>{'{{variables}}'}</code> and keep the real credentials in an
          environment, where secrets are encrypted in this browser.
        </p>
      ) : null}
    </div>
  );
}

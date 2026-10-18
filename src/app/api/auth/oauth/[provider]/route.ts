import {
  authorizationUrl,
  callbackUrl,
  createOAuthState,
  describeRedirectMismatch,
  isOAuthProvider,
  oauthStateCookie,
  providerConfig,
} from '@/lib/auth/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function secure(request: Request): boolean {
  return request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:';
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: raw } = await context.params;
  if (!isOAuthProvider(raw)) return Response.json({ error: 'Unknown OAuth provider' }, { status: 404 });
  const config = providerConfig(raw);
  if (!config) return Response.json({ error: `${raw} OAuth is not configured` }, { status: 503 });

  const state = createOAuthState(raw);
  const redirectUri = callbackUrl(request, raw);

  /*
   * Fail here, with the reason, rather than handing the user a provider error
   * page. A redirect_uri the provider will reject is a configuration problem,
   * and "Error 400: redirect_uri_mismatch" does not say which URI was sent.
   */
  const mismatch = describeRedirectMismatch(request, redirectUri);
  if (mismatch) {
    const home = new URL('/', request.url);
    home.searchParams.set('auth_error', mismatch);
    return new Response(null, { status: 302, headers: { location: home.href } });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizationUrl(raw, config, redirectUri, state),
      'set-cookie': oauthStateCookie(state, secure(request)),
    },
  });
}

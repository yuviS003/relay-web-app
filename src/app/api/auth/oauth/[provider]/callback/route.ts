import { signInWithOAuth } from '@/lib/auth';
import {
  callbackUrl,
  clearedOAuthStateCookie,
  fetchOAuthProfile,
  isOAuthProvider,
  providerConfig,
  readOAuthState,
} from '@/lib/auth/oauth';
import { mfaChallengeCookie, sessionCookie } from '@/lib/auth/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function secure(request: Request): boolean {
  return request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:';
}

function home(request: Request, error?: string): string {
  const url = new URL('/', request.url);
  if (error) url.searchParams.set('auth_error', error);
  return url.href;
}

function mfaStep(request: Request): string {
  const url = new URL('/', request.url);
  url.searchParams.set('mfa', 'required');
  return url.href;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: raw } = await context.params;
  const isSecure = secure(request);
  if (!isOAuthProvider(raw)) return Response.redirect(home(request, 'Unknown OAuth provider'));

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = readOAuthState(request.headers.get('cookie'));
  const config = providerConfig(raw);
  if (!config || !code || !state || state !== expected || !state.startsWith(`${raw}.`)) {
    return new Response(null, {
      status: 302,
      headers: {
        location: home(request, 'OAuth sign-in could not be verified'),
        'set-cookie': clearedOAuthStateCookie(isSecure),
      },
    });
  }

  try {
    const profile = await fetchOAuthProfile(raw, config, code, callbackUrl(request, raw));
    const outcome = await signInWithOAuth(raw, profile.subject, profile.email);
    if (!outcome.ok) throw new Error(outcome.error);

    /*
     * An account with a second factor is not signed in yet. The provider
     * proved the email address; the app still wants the code, so the redirect
     * carries a challenge cookie and lands on the sign-in form's code step.
     */
    if ('mfaRequired' in outcome) {
      const pending = new Headers({ location: mfaStep(request) });
      pending.append('set-cookie', mfaChallengeCookie(outcome.challengeToken, isSecure));
      pending.append('set-cookie', clearedOAuthStateCookie(isSecure));
      return new Response(null, { status: 302, headers: pending });
    }

    const headers = new Headers({ location: home(request) });
    headers.append('set-cookie', sessionCookie(outcome.token, isSecure));
    headers.append('set-cookie', clearedOAuthStateCookie(isSecure));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return new Response(null, {
      status: 302,
      headers: {
        location: home(request, error instanceof Error ? error.message : 'OAuth sign-in failed'),
        'set-cookie': clearedOAuthStateCookie(isSecure),
      },
    });
  }
}

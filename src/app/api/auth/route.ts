import {
  accountDb,
  authMode,
  completeMfaChallenge,
  completePasswordReset,
  createPasswordReset,
  currentUser,
  signIn,
  signInWithPasskey,
  signOut,
  signUp,
} from '@/lib/auth';
import { oauthAvailability, requestOrigin } from '@/lib/auth/oauth';
import {
  beginDiscoverablePasskeyAuthentication,
  finishDiscoverablePasskeyAuthentication,
} from '@/lib/auth/passkeys';
import { mailerConfigured, passwordResetMessage, sendMail } from '@/lib/mail';
import {
  clearedMfaChallengeCookie,
  clearedPasskeyHandleCookie,
  clearedSessionCookie,
  createSessionToken,
  mfaChallengeCookie,
  passkeyHandleCookie,
  readMfaChallengeToken,
  readPasskeyHandle,
  sessionCookie,
} from '@/lib/auth/sessions';
import { resolveClientIdentity } from '@/lib/net/client-ip';
import { AUTH_POLICY, consumeQuota } from '@/lib/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isSecureRequest(request: Request): boolean {
  // Vercel terminates TLS upstream, so the scheme on the inbound request is
  // http. The forwarded header is what tells us the browser used https, and
  // the Secure cookie flag depends on getting this right.
  return (
    request.headers.get('x-forwarded-proto') === 'https' ||
    new URL(request.url).protocol === 'https:'
  );
}



/** Who am I? Used on load to decide between the app and the sign-in page. */
export async function GET(request: Request): Promise<Response> {
  const user = await currentUser(request.headers.get('cookie'));
  return Response.json({ mode: await authMode(), user, oauth: oauthAvailability() });
}

export async function POST(request: Request): Promise<Response> {
  let body: {
    action?: unknown;
    email?: unknown;
    password?: unknown;
    code?: unknown;
    token?: unknown;
    response?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const isSecure = isSecureRequest(request);

  /*
   * Signing out is handled before the throttle, and does not spend it.
   *
   * It tests no credential — it drops the caller's own session — so counting
   * it against a budget meant for guessing had one real effect: someone who
   * had just finished enrolling a second factor, signing in with a code and
   * adding a passkey pressed Sign out and was told to wait. A control that
   * traps a user inside a session they asked to leave is worse than no control
   * on this particular action.
   */
  if (body.action === 'signout') {
    await signOut(request.headers.get('cookie'));
    const headers = new Headers();
    headers.append('set-cookie', clearedSessionCookie(isSecure));
    // An abandoned second-factor step must not outlive the sign-out either.
    headers.append('set-cookie', clearedMfaChallengeCookie(isSecure));
    return Response.json({ ok: true }, { headers });
  }

  /*
   * Everything past here either tests a credential or sends mail, so it is
   * throttled per caller. Without this the sign-in endpoint is an online
   * password cracker with unlimited attempts; scrypt's cost protects the stored
   * hashes, not the form.
   *
   * The identity cannot come from a forgeable header, or the throttle is
   * bypassed by rotating one. See lib/net/client-ip.ts: unidentified callers
   * share a single bucket rather than each getting a fresh allowance.
   */
  const quota = await consumeQuota(
    `auth:${resolveClientIdentity(request.headers).key}`,
    AUTH_POLICY,
  );
  if (!quota.allowed) {
    return Response.json(
      { error: 'Too many attempts. Wait a moment.', retryAfterMs: quota.retryAfterMs },
      {
        status: 429,
        headers: { 'retry-after': String(Math.ceil(quota.retryAfterMs / 1000)) },
      },
    );
  }

  /*
   * Asking for a reset link.
   *
   * The answer is the same whether or not the address has an account, so the
   * form cannot be used to test which addresses are registered. Whether the
   * deployment can send mail at all is reported, because that is a property of
   * the server rather than of the account, and a user waiting for a message
   * that can never arrive deserves to know.
   */
  /*
   * Passwordless sign-in with a passkey, in two calls: ask for a challenge,
   * then present what the authenticator signed. No email is involved, so
   * neither call can be used to ask whether an address is registered.
   */
  if (body.action === 'passkey-options') {
    try {
      const db = await accountDb();
      const handle = createSessionToken().token;
      const options = await beginDiscoverablePasskeyAuthentication(db, request, handle);
      return Response.json(
        { options },
        { headers: { 'set-cookie': passkeyHandleCookie(handle, isSecure) } },
      );
    } catch {
      return Response.json(
        { error: 'Passkeys need a configured database' },
        { status: 503 },
      );
    }
  }

  if (body.action === 'passkey-verify') {
    const handle = readPasskeyHandle(request.headers.get('cookie'));
    if (!handle) {
      return Response.json({ error: 'Start the passkey sign-in again' }, { status: 401 });
    }
    let verified;
    try {
      const db = await accountDb();
      verified = await finishDiscoverablePasskeyAuthentication(
        db,
        request,
        handle,
        body.response,
      );
    } catch {
      return Response.json({ error: 'Passkey verification failed' }, { status: 503 });
    }
    if (!verified.ok) {
      return Response.json({ error: verified.error }, { status: 401 });
    }

    const outcome = await signInWithPasskey(verified.userId);
    if (!outcome.ok) {
      return Response.json({ error: outcome.error }, { status: outcome.status });
    }
    if ('mfaRequired' in outcome) {
      // Not reachable today — a passkey is accepted as sufficient — but
      // handled rather than assumed away.
      return Response.json(
        { mfaRequired: true },
        { headers: { 'set-cookie': mfaChallengeCookie(outcome.challengeToken, isSecure) } },
      );
    }

    const headers = new Headers();
    headers.append('set-cookie', sessionCookie(outcome.token, isSecure));
    headers.append('set-cookie', clearedPasskeyHandleCookie(isSecure));
    return Response.json({ user: outcome.user }, { headers });
  }

  if (body.action === 'reset-request') {
    const configured = mailerConfigured();
    const issued = configured ? await createPasswordReset(body.email) : null;

    if (issued) {
      const origin = requestOrigin(request);
      const link = `${origin}/?reset=${encodeURIComponent(issued.token)}`;
      const sent = await sendMail(passwordResetMessage(issued.email, link));
      if (!sent.ok) {
        // Logged, not returned: the reason can reveal whether the address
        // exists, and the user can do nothing with a provider error.
        console.error(`[auth] reset mail failed: ${sent.reason} ${sent.detail}`);
      }
    }

    return Response.json({
      ok: true,
      mailerConfigured: configured,
      message: configured
        ? 'If that address has an account, a reset link is on its way.'
        : 'Email delivery is not configured on this deployment, so no link can be sent.',
    });
  }

  if (body.action === 'reset-complete') {
    const outcome = await completePasswordReset(body.token, body.password);
    if ('error' in outcome) {
      return Response.json({ error: outcome.error }, { status: outcome.status });
    }
    const headers = new Headers();
    // Every session was dropped by the reset, including any stale one here.
    headers.append('set-cookie', clearedSessionCookie(isSecure));
    headers.append('set-cookie', clearedMfaChallengeCookie(isSecure));
    return Response.json({ ok: true }, { headers });
  }

  if (
    body.action !== 'signin' &&
    body.action !== 'signup' &&
    body.action !== 'mfa'
  ) {
    return Response.json(
      {
        error:
          "action must be 'signin', 'signup', 'mfa', 'reset-request', 'reset-complete', or 'signout'",
      },
      { status: 400 },
    );
  }

  const outcome =
    body.action === 'signup'
      ? await signUp(body.email, body.password)
      : body.action === 'mfa'
        ? await completeMfaChallenge(
            // The challenge travels in an HttpOnly cookie, never in the body:
            // a half-authenticated token handed to script is a token an XSS
            // can finish signing in with.
            readMfaChallengeToken(request.headers.get('cookie')),
            body.code,
          )
        : await signIn(body.email, body.password);

  if (!outcome.ok) {
    return Response.json({ error: outcome.error }, { status: outcome.status });
  }

  if ('mfaRequired' in outcome) {
    return Response.json(
      { mfaRequired: true },
      { headers: { 'set-cookie': mfaChallengeCookie(outcome.challengeToken, isSecure) } },
    );
  }

  const headers = new Headers();
  headers.append('set-cookie', sessionCookie(outcome.token, isSecure));
  headers.append('set-cookie', clearedMfaChallengeCookie(isSecure));
  return Response.json({ user: outcome.user }, { headers });
}

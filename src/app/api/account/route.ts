import {
  accountDb,
  accountOverview,
  changePassword,
  confirmMfaSetup,
  currentUser,
  deleteAccount,
  disableMfa,
  exportAccount,
  regenerateRecoveryCodes,
  revokeOtherSessions,
  setMfaPromptSkipped,
  setTourDone,
  startMfaSetup,
} from '@/lib/auth';
import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  removePasskey,
} from '@/lib/auth/passkeys';
import { clearedSessionCookie } from '@/lib/auth/sessions';
import { resolveClientIdentity } from '@/lib/net/client-ip';
import { AUTH_POLICY, consumeQuota } from '@/lib/quota';
import { renderQr } from '@/lib/qr';

/*
 * Managing an account that already exists: profile, password, second factor,
 * other sessions, and the two "don't show me this again" flags behind the
 * onboarding tour and the MFA nudge.
 *
 * Separate from /api/auth, which is only about establishing a session. Every
 * handler here resolves the caller from the session cookie; none of them take
 * a user id, so there is no object to confuse for someone else's.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Actions that check a password or a one-time code pay the auth throttle. */
const GUESSABLE = new Set([
  'mfa-confirm',
  'mfa-disable',
  'recovery-regenerate',
  'password-change',
  'delete',
]);

function isSecureRequest(request: Request): boolean {
  return (
    request.headers.get('x-forwarded-proto') === 'https' ||
    new URL(request.url).protocol === 'https:'
  );
}

function failed(result: unknown): result is { error: string; status: number } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    'status' in result
  );
}

function respond(result: unknown): Response {
  if (failed(result)) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json(result as Record<string, unknown>);
}

export async function GET(request: Request): Promise<Response> {
  return respond(await accountOverview(request.headers.get('cookie')));
}

export async function POST(request: Request): Promise<Response> {
  let body: {
    action?: unknown;
    code?: unknown;
    password?: unknown;
    currentPassword?: unknown;
    newPassword?: unknown;
    done?: unknown;
    response?: unknown;
    label?: unknown;
    credentialId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  if (GUESSABLE.has(action)) {
    const quota = await consumeQuota(
      `account:${resolveClientIdentity(request.headers).key}`,
      AUTH_POLICY,
    );
    if (!quota.allowed) {
      return Response.json(
        { error: 'Too many attempts. Wait a moment.' },
        {
          status: 429,
          headers: { 'retry-after': String(Math.ceil(quota.retryAfterMs / 1000)) },
        },
      );
    }
  }

  const cookie = request.headers.get('cookie');

  switch (action) {
    case 'mfa-start': {
      const result = await startMfaSetup(cookie);
      if (failed(result)) return respond(result);
      // The QR is rendered here rather than in the browser: the client needs
      // a picture, not a QR encoder in its bundle.
      return Response.json({ ...result, qr: renderQr(result.uri) });
    }
    case 'mfa-confirm':
      return respond(await confirmMfaSetup(cookie, body.code));
    case 'mfa-disable':
      return respond(
        await disableMfa(cookie, { password: body.password, code: body.code }),
      );
    case 'recovery-regenerate':
      return respond(
        await regenerateRecoveryCodes(cookie, {
          password: body.password,
          code: body.code,
        }),
      );
    case 'password-change':
      return respond(
        await changePassword(cookie, body.currentPassword, body.newPassword),
      );
    case 'sessions-revoke':
      return respond(await revokeOtherSessions(cookie));
    case 'export':
      return respond(await exportAccount(cookie));

    /* ----- passkeys ----- */
    case 'passkey-register-options': {
      const user = await currentUser(cookie);
      if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
      try {
        const db = await accountDb();
        return Response.json({
          options: await beginPasskeyRegistration(db, request, user),
        });
      } catch {
        return Response.json(
          { error: 'Passkeys need a configured database' },
          { status: 503 },
        );
      }
    }
    case 'passkey-register': {
      const user = await currentUser(cookie);
      if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
      const db = await accountDb();
      const result = await finishPasskeyRegistration(
        db,
        request,
        user,
        body.response,
        typeof body.label === 'string' ? body.label : 'Passkey',
      );
      return result.ok
        ? Response.json({ ok: true })
        : Response.json({ error: result.error }, { status: 400 });
    }
    case 'passkey-remove': {
      const user = await currentUser(cookie);
      if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
      if (typeof body.credentialId !== 'string') {
        return Response.json({ error: 'credentialId is required' }, { status: 400 });
      }
      const db = await accountDb();
      const removed = await removePasskey(db, user.id, body.credentialId);
      return removed
        ? Response.json({ ok: true })
        : Response.json({ error: 'No such passkey' }, { status: 404 });
    }
    case 'delete': {
      const result = await deleteAccount(cookie, {
        password: body.password,
        code: body.code,
      });
      if (failed(result)) return respond(result);
      // The account is gone, so the cookie pointing at it must go too.
      return Response.json(
        { ok: true },
        { headers: { 'set-cookie': clearedSessionCookie(isSecureRequest(request)) } },
      );
    }
    case 'mfa-skip':
      return respond(await setMfaPromptSkipped(cookie));
    case 'tour-done':
      return respond(await setTourDone(cookie, body.done !== false));
    default:
      return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  }
}

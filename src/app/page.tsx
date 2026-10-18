'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { BootScreen } from '@/components/boot-screen';

import { AuthCard } from './auth-card';
import { Workbench } from './workbench';

export type SessionUser = {
  id: string;
  email: string;
  mfaEnabled: boolean;
  /** The account has no second factor and has not declined the offer. */
  offerMfa: boolean;
  tourDone: boolean;
  hasPassword: boolean;
};

type Session = {
  mode: 'accounts' | 'local' | 'degraded';
  user: SessionUser | null;
  oauth?: { google: boolean; github: boolean };
};

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [guest, setGuest] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [factorPending, setFactorPending] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(null);

  /*
   * Guards against a session read landing after the state it describes is
   * already out of date.
   *
   * The bug this fixes: registering a passkey refreshes the account, which
   * starts a session read. Pressing Sign out immediately afterwards cleared
   * the session on the server and in state — and then the earlier read
   * resolved, still carrying the signed-in user, and put it back. The result
   * was a workbench that looked signed in while every write failed with "sign
   * in first", because the cookie was gone. Any newer decision bumps this, and
   * an older read that finishes late is discarded.
   */
  const sessionEpoch = useRef(0);

  const load = useCallback(async () => {
    const epoch = sessionEpoch.current;
    try {
      const response = await fetch('/api/auth', { cache: 'no-store' });
      const next = (await response.json()) as Session;
      if (epoch !== sessionEpoch.current) return;
      setSession(next);
      if (next.user) {
        setGuest(false);
        setAuthOpen(false);
        setFactorPending(false);
        /*
         * Both of these describe how this visit *started*, and a session now
         * exists, so they are spent. Keeping the reset token was a bug you
         * only met later: signing out re-rendered the card, saw a token still
         * in state, and opened "choose a new password" with a link that had
         * already been used — reported as "I signed out and it told me my
         * reset link expired".
         */
        setResetToken(null);
        setAuthError(null);
      }
    } catch {
      if (epoch !== sessionEpoch.current) return;
      // Treat an unreachable auth endpoint as local mode rather than blocking
      // on a sign-in form that cannot work.
      setSession({
        mode: 'local',
        user: {
          id: 'local',
          email: 'local',
          mfaEnabled: false,
          offerMfa: false,
          tourDone: false,
          hasPassword: false,
        },
      });
    }
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    let cleaned = false;

    const error = url.searchParams.get('auth_error');
    if (error) {
      setAuthError(error);
      url.searchParams.delete('auth_error');
      cleaned = true;
    }
    /*
     * A provider sign-in that stopped at the second factor comes back here
     * with ?mfa=required and a challenge cookie, so the form opens on the code
     * step instead of asking for a password the account may not even have.
     */
    if (url.searchParams.get('mfa') === 'required') {
      setFactorPending(true);
      url.searchParams.delete('mfa');
      cleaned = true;
    }
    /*
     * A reset link lands here with its token. It is taken out of the address
     * bar immediately: a single-use credential has no business sitting in
     * browser history or in a Referer header.
     */
    const reset = url.searchParams.get('reset');
    if (reset) {
      setResetToken(reset);
      url.searchParams.delete('reset');
      cleaned = true;
    }
    if (cleaned) window.history.replaceState(null, '', url);
    void load();
  }, [load]);

  if (!session) {
    return <BootScreen title="Starting Relay" message="Checking your session…" />;
  }

  if (!session.user && (!guest || factorPending || resetToken)) {
    return (
      <AuthCard
        oauth={session.oauth ?? { google: false, github: false }}
        initialError={authError}
        initialStage={
          resetToken ? 'reset' : factorPending ? 'factor' : 'credentials'
        }
        resetToken={resetToken ?? undefined}
        onSignedIn={() => void load()}
        onContinueGuest={
          factorPending || resetToken ? undefined : () => setGuest(true)
        }
      />
    );
  }

  const workbenchMode = session.user ? session.mode : 'guest';

  return (
    <>
      <Workbench
        email={session.user?.email ?? 'Guest'}
        mode={workbenchMode}
        account={session.user}
        onAccountChanged={() => load()}
        onRequireSignIn={() => setAuthOpen(true)}
        onSignedOut={() => {
          // Newer than any read already in flight, so one that resolves late
          // cannot hand the session back.
          sessionEpoch.current += 1;
          setGuest(false);
          setSession({ ...session, user: null });
        }}
      />
      {authOpen && !session.user ? (
        <div className="authOverlay">
          <AuthCard
            oauth={session.oauth ?? { google: false, github: false }}
            onSignedIn={() => void load()}
            onClose={() => setAuthOpen(false)}
          />
        </div>
      ) : null}
    </>
  );
}

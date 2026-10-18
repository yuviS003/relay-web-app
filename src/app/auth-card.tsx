'use client';

import { useState } from 'react';

import { GitHubMark, GoogleMark } from '@/components/brand-icons';
import { CodeInput } from '@/components/code-input';
import { Logo } from '@/components/logo';
import { PasswordField } from '@/components/password-field';
import {
  parseRequestOptionsFromJSON,
  passkeysAvailable,
  serialiseCredential,
} from '@/components/webauthn';
import { PwaInstall } from '@/components/pwa-install';
import { ThemeToggle } from '@/components/theme-toggle';

type OAuthAvailability = { google: boolean; github: boolean };

/**
 * Sign in and sign up on one surface. Switching mode keeps whatever is already
 * typed, because the common case is discovering you have no account after
 * entering the email.
 */
export function AuthCard({
  onSignedIn,
  onContinueGuest,
  onClose,
  oauth = { google: false, github: false },
  initialError = null,
  initialStage = 'credentials',
  resetToken,
}: {
  onSignedIn: () => void;
  // Explicitly optional-or-undefined: the caller withholds the guest path
  // while a second-factor step is in progress.
  onContinueGuest?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  oauth?: OAuthAvailability;
  initialError?: string | null;
  /** 'factor' resumes a sign-in that a provider redirect left mid-challenge. */
  initialStage?: 'credentials' | 'factor' | 'reset';
  /** The token from a reset link, when the stage is 'reset'. */
  resetToken?: string | undefined;
}) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [stage, setStage] = useState<'credentials' | 'factor' | 'reset'>(initialStage);
  /** The factor step accepts either a six-digit code or a recovery code. */
  const [recovery, setRecovery] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [resetNote, setResetNote] = useState<string | null>(null);

  const completeReset = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'reset-complete',
          token: resetToken,
          password,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(String(data.error ?? 'That reset link is not valid'));
        return;
      }
      // The reset dropped every session, including any this tab had, so the
      // password just set is used to sign in normally.
      setStage('credentials');
      setMode('signin');
      setResetNote('Password updated. Sign in with it now.');
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: mode, email, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(String(data.error ?? 'Could not sign in'));
        return;
      }
      /*
       * The password was right but the account has a second factor, so no
       * session came back — only a short-lived challenge cookie. Nothing about
       * the account is revealed here beyond "this step exists".
       */
      if (data.mfaRequired) {
        setStage('factor');
        setPassword('');
        return;
      }
      onSignedIn();
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setBusy(false);
    }
  };

  /*
   * Separated from the form event so a filled six-box code can verify itself.
   * Guarded against a double submit: autofill completing the last box fires
   * this, and the form's own submit could fire it again.
   */
  const verifyFactor = async (entered: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'mfa', code: entered }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(String(data.error ?? 'That code is not valid'));
        return;
      }
      onSignedIn();
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setBusy(false);
    }
  };

  /*
   * Passwordless sign-in. No email is typed: the server hands out a challenge
   * with no credential list, the authenticator offers whatever it holds for
   * this origin, and the credential it signs with identifies the account. That
   * is also why this cannot be used to probe which addresses are registered.
   */
  const signInWithPasskey = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (!passkeysAvailable()) {
        throw new Error('This browser does not support passkeys');
      }
      const optionsResponse = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'passkey-options' }),
      });
      const optionsBody = await optionsResponse.json();
      if (!optionsResponse.ok) {
        throw new Error(String(optionsBody.error ?? 'Passkeys are unavailable'));
      }

      const assertion = await navigator.credentials.get({
        publicKey: parseRequestOptionsFromJSON(optionsBody.options),
      });
      if (!assertion) throw new Error('No passkey was presented');

      const credential = assertion as PublicKeyCredential;
      const verifyResponse = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'passkey-verify',
          response:
            typeof (credential as unknown as { toJSON?: () => unknown }).toJSON ===
            'function'
              ? (credential as unknown as { toJSON: () => unknown }).toJSON()
              : serialiseCredential(credential),
        }),
      });
      const verifyBody = await verifyResponse.json();
      if (!verifyResponse.ok) {
        throw new Error(String(verifyBody.error ?? 'That passkey was not accepted'));
      }
      onSignedIn();
    } catch (problem) {
      const name = problem instanceof Error ? problem.name : '';
      setError(
        name === 'NotAllowedError' || name === 'AbortError'
          ? 'That was cancelled.'
          : problem instanceof Error
            ? problem.message
            : 'Passkey sign-in failed',
      );
    } finally {
      setBusy(false);
    }
  };

  const requestReset = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResetNote(null);
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reset-request', email }),
      });
      const data = await response.json();
      setResetNote(
        String(
          data.message ??
            'If that address has an account, a reset link is on its way.',
        ),
      );
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'reset') {
    return (
      <div className="authWrap">
        <div className="authSplit authSplit--single">
          <div className="authForm authForm--focused">
            <span className="brand">
              <Logo size={24} />
              <h1>Choose a new password</h1>
            </span>
            <p className="hint" style={{ margin: '0.2rem 0 0' }}>
              This link works once. Setting a password signs out every device.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void completeReset();
              }}
            >
              <div className="field">
                <label htmlFor="reset-password">New password</label>
                <PasswordField
                  id="reset-password"
                  autoFocus
                  required
                  minLength={10}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <p className="hint">At least 10 characters. A phrase beats a word.</p>
              </div>

              {error ? (
                <p className="notice bad" role="alert" style={{ marginBottom: '0.8rem' }}>
                  {error}
                </p>
              ) : null}
              {resetNote ? (
                <p className="notice good" role="status" style={{ marginBottom: '0.8rem' }}>
                  {resetNote}
                </p>
              ) : null}

              <button
                type="submit"
                className="primary"
                disabled={busy}
                style={{ width: '100%' }}
              >
                {busy ? 'Saving…' : 'Set password and sign in'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (stage === 'factor') {
    return (
      <div className="authWrap">
        <div className="authSplit authSplit--single">
          <div className="authForm authForm--focused">
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span className="brand" style={{ flex: 1 }}>
                <Logo size={24} />
                <h1>Two-factor code</h1>
              </span>
              {onClose ? (
                <button
                  type="button"
                  className="ghost"
                  aria-label="Close sign in"
                  onClick={onClose}
                >
                  ×
                </button>
              ) : null}
            </div>
            <p className="hint" style={{ margin: '0.2rem 0 0' }}>
              {recovery
                ? 'Enter one of the recovery codes issued when you turned on two-factor authentication. Each works once.'
                : 'Open your authenticator app and enter the six digits it shows for Relay. They change every 30 seconds.'}
            </p>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void verifyFactor(code);
              }}
            >
              <div className="field">
                <label htmlFor="factor-code">
                  {recovery ? 'Recovery code' : 'Authenticator code'}
                </label>
                {recovery ? (
                  <input
                    id="factor-code"
                    className="recoveryInput"
                    autoFocus
                    required
                    autoComplete="one-time-code"
                    spellCheck={false}
                    placeholder="abcde-fghij"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                ) : (
                  <CodeInput
                    id="factor-code"
                    label="Six-digit authenticator code"
                    autoFocus
                    disabled={busy}
                    invalid={error !== null}
                    value={code}
                    onChange={setCode}
                    // Verifying as soon as the sixth digit lands: the button
                    // stays for anyone who prefers to press it.
                    onComplete={(filled) => void verifyFactor(filled)}
                  />
                )}
              </div>

              {error ? (
                <p className="notice bad" style={{ marginBottom: '0.8rem' }} role="alert">
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                className="primary"
                disabled={busy || code.trim() === ''}
                style={{ width: '100%' }}
              >
                {busy ? 'Checking…' : 'Verify and sign in'}
              </button>
            </form>

            <div className="authSecondary">
              <button
                type="button"
                className="linkButton"
                onClick={() => {
                  setRecovery((current) => !current);
                  setCode('');
                  setError(null);
                }}
              >
                {recovery
                  ? 'Use a six-digit code instead'
                  : 'Lost your authenticator? Use a recovery code'}
              </button>
              <button
                type="button"
                className="linkButton"
                onClick={() => {
                  setStage('credentials');
                  setRecovery(false);
                  setCode('');
                  setError(null);
                }}
              >
                Start over
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="authWrap">
      <div className="authSplit">
        {/* Hidden below 52rem: on a phone the form is the only thing worth
            the vertical space. */}
        <aside className="authPitch">
          {/* The product is Relay everywhere else — the window title, the
              manifest, the toolbar. The sign-in panel called itself "Web API
              client", which is the description, not the name. */}
          <span className="brand">
            <Logo size={26} />
            <h1>Relay</h1>
            <span className="brandNote">Web API client</span>
          </span>
          <h2 style={{ marginTop: '1.6rem' }}>What makes it different</h2>
          <ul>
            <li>
              <strong>A proxy that refuses private networks</strong>
              Blocks loopback, link-local and cloud metadata by resolved
              address, and re-checks every redirect hop.
            </li>
            <li>
              <strong>Secrets encrypted in your browser</strong>
              AES-GCM with a key derived from your passphrase. The server
              stores ciphertext it cannot read.
            </li>
            <li>
              <strong>Scripts in a real sandbox</strong>
              Pre-request code runs in WebAssembly with no network, no
              filesystem and a one-second limit.
            </li>
            <li>
              <strong>Copy as code</strong>
              cURL, fetch, Go, Java, Rust and a dozen more, with variables
              resolved and values quoted so pasting is safe.
            </li>
          </ul>
        </aside>

        <div className="authForm">
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <h1>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>
              </div>
              {/* Close sits last, in the corner, because that is where a
                  dismiss belongs; it used to sit left of the theme toggle,
                  which read as part of the controls rather than above them. */}
              <PwaInstall />
              <ThemeToggle />
              {onClose ? (
                <button type="button" className="ghost" aria-label="Close sign in" onClick={onClose}>×</button>
              ) : null}
            </div>
          <p className="hint" style={{ margin: '0.2rem 0 0' }}>
            Collections and environments stay private to your account.
          </p>

        <div className="authToggle" role="group" aria-label="Sign in or sign up">
          <button
            type="button"
            aria-pressed={mode === 'signin'}
            onClick={() => {
              setMode('signin');
              setError(null);
            }}
          >
            Sign in
          </button>
          <button
            type="button"
            aria-pressed={mode === 'signup'}
            onClick={() => {
              setMode('signup');
              setError(null);
            }}
          >
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <PasswordField
              id="password"
              // Tells a password manager whether to offer a saved entry or to
              // generate a new one.
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'signup' ? 10 : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {mode === 'signup' ? (
              <p className="hint">At least 10 characters. A phrase beats a word.</p>
            ) : null}
          </div>

          {error ? (
            <p className="notice bad" style={{ marginBottom: '0.8rem' }}>
              {error}
            </p>
          ) : null}

          <button type="submit" className="primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        {mode === 'signin' ? (
          <div className="authSecondary">
            <button
              type="button"
              className="linkButton"
              disabled={busy}
              onClick={() => void requestReset()}
            >
              Forgot your password?
            </button>
            {resetNote ? (
              <p className="notice good" role="status">
                {resetNote}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="authDivider"><span>or</span></div>

        <button
          type="button"
          className="passkeyButton"
          disabled={busy}
          onClick={() => void signInWithPasskey()}
        >
          <span aria-hidden="true">🔑</span>
          Sign in with a passkey
          <small>No password, and nothing to phish.</small>
        </button>

        <div className="oauthButtons">
          {(['google', 'github'] as const).map((provider) => {
            const label = provider === 'google' ? 'Google' : 'GitHub';
            const Mark = provider === 'google' ? GoogleMark : GitHubMark;
            // The label stays short so it is never truncated to an ambiguous
            // "Continue with G…" in the two-column row; the mark carries the
            // provider identity and the hint below explains an inactive one.
            return oauth[provider] ? (
              <a
                className="oauthButton"
                href={`/api/auth/oauth/${provider}`}
                key={provider}
                aria-label={`Continue with ${label}`}
              >
                <Mark />
                <span>{label}</span>
              </a>
            ) : (
              <button
                type="button"
                className="oauthButton"
                disabled
                key={provider}
                aria-label={`${label} sign-in is not configured`}
                title={`Set ${provider.toUpperCase()}_OAUTH_CLIENT_ID and _SECRET in .env`}
              >
                <Mark />
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        {!oauth.google || !oauth.github ? (
          <p className="hint" style={{ margin: '0.45rem 0 0' }}>
            {[!oauth.google && 'Google', !oauth.github && 'GitHub']
              .filter(Boolean)
              .join(' and ')}{' '}
            sign-in needs client credentials in <code>.env</code>.
          </p>
        ) : null}

        {onContinueGuest ? (
          <button type="button" className="guestButton" onClick={onContinueGuest}>
            Continue as guest
            <small>Send and analyse requests; sign in only when you save.</small>
          </button>
        ) : null}
        </div>
      </div>
    </div>
  );
}

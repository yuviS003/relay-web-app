'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AppDialog } from './app-dialog';
import { MfaSetupDialog } from './mfa-dialog';
import {
  parseCreationOptionsFromJSON,
  parseRequestOptionsFromJSON,
  serialiseCredential,
  type PublicKeyCredentialCreationOptionsJSON,
} from './webauthn';
import { PasswordField } from './password-field';

type Overview = {
  user: {
    id: string;
    email: string;
    mfaEnabled: boolean;
    offerMfa: boolean;
    tourDone: boolean;
    hasPassword: boolean;
  };
  createdAt: string;
  signInMethods: string[];
  mfa: { enabled: boolean; enabledAt: string | null; recoveryRemaining: number };
  passkeys: {
    credentialId: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
  otherSessions: number;
};

type SettingsPanelProps = {
  open: boolean;
  email: string;
  mode: 'accounts' | 'local' | 'degraded' | 'guest';
  onClose: () => void;
  onAccountChanged: () => void | Promise<void>;
  onStartTour: () => void;
  onSignIn: () => void;
};

const METHOD_LABELS: Record<string, string> = {
  password: 'Password',
  google: 'Google',
  github: 'GitHub',
};

async function act<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'That did not work');
  return data;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'unknown'
    : date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
}

/**
 * Account settings: who you are, how you sign in, and the second factor.
 *
 * A native dialog again, for the same reasons as the smaller ones — focus
 * stays inside, Escape closes, the workbench behind it is inert — but with
 * several independent forms rather than one, because each section here
 * succeeds or fails on its own.
 */
export function SettingsPanel({
  open,
  email,
  mode,
  onClose,
  onAccountChanged,
  onStartTour,
  onSignIn,
}: SettingsPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mfaOpen, setMfaOpen] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNote, setPasswordNote] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [proof, setProof] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaNote, setMfaNote] = useState<string | null>(null);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  const [sessionNote, setSessionNote] = useState<string | null>(null);

  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyNote, setPasskeyNote] = useState<string | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  const [dataNote, setDataNote] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteProof, setDeleteProof] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/account', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) {
        /*
         * 401 and 403 mean there is no session to describe, so whatever is on
         * screen is the *previous* account and has to go: after signing out,
         * the panel was still listing that account's passkeys and sessions.
         * Any other failure is treated as transient and leaves the view alone.
         */
        if (response.status === 401 || response.status === 403) setOverview(null);
        setLoadError(String(data.error ?? 'Could not load the account'));
        return;
      }
      setOverview(data as Overview);
      setLoadError(null);
    } catch {
      // A failed refresh reports itself but keeps what is already on screen:
      // blanking a dialog someone is reading is worse than a stale number.
      setLoadError('Could not reach the server');
    }
  }, []);

  /*
   * Fetched when the workbench mounts, not when the dialog opens.
   *
   * The overview is one small document, and loading it on open meant the
   * dialog appeared empty and filled in a beat later — every single time it
   * was opened. Prefetching makes the first open instant and every reopen
   * immediate from what is already in state; the fetch on open below only
   * refreshes it.
   */
  useEffect(() => {
    if (mode !== 'accounts') return;
    void load();
  }, [mode, load]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      void load();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, load]);

  useEffect(() => {
    if (open) return;
    setCurrentPassword('');
    setNewPassword('');
    setPasswordNote(null);
    setPasswordError(null);
    setProof('');
    setMfaError(null);
    setMfaNote(null);
    setFreshCodes(null);
    setSessionNote(null);
  }, [open]);

  const refresh = async () => {
    await load();
    await onAccountChanged();
  };

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordBusy(true);
    setPasswordError(null);
    setPasswordNote(null);
    try {
      await act({
        action: 'password-change',
        currentPassword,
        newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setPasswordNote(
        'Password updated. Any other signed-in device was signed out.',
      );
      await refresh();
    } catch (problem) {
      setPasswordError(
        problem instanceof Error ? problem.message : 'Could not change it',
      );
    } finally {
      setPasswordBusy(false);
    }
  };

  const runProofAction = async (
    action: 'mfa-disable' | 'recovery-regenerate',
  ) => {
    setMfaBusy(true);
    setMfaError(null);
    setMfaNote(null);
    setFreshCodes(null);
    try {
      // One field covers both proofs: an account with a password sends that,
      // an OAuth-only account sends a current code or a recovery code.
      const payload = overview?.user.hasPassword
        ? { action, password: proof }
        : { action, code: proof };
      const result = await act<{ codes?: string[] }>(payload);
      setProof('');
      if (action === 'mfa-disable') {
        setMfaNote('Two-factor authentication is off.');
      } else {
        setFreshCodes(result.codes ?? []);
        setMfaNote('New codes issued. The previous ones no longer work.');
      }
      await refresh();
    } catch (problem) {
      setMfaError(problem instanceof Error ? problem.message : 'That did not work');
    } finally {
      setMfaBusy(false);
    }
  };

  const revokeSessions = async () => {
    setSessionNote(null);
    try {
      const result = await act<{ revoked: number }>({ action: 'sessions-revoke' });
      setSessionNote(
        result.revoked === 0
          ? 'There were no other sessions.'
          : `Signed out ${result.revoked} other session${result.revoked === 1 ? '' : 's'}.`,
      );
      await refresh();
    } catch (problem) {
      setSessionNote(
        problem instanceof Error ? problem.message : 'Could not sign them out',
      );
    }
  };

  /*
   * Registering a passkey.
   *
   * The options come from the server with a stored challenge, the browser
   * talks to the authenticator, and the signed result goes back for
   * verification. The base64url conversions are done here rather than with a
   * second dependency: they are three lines each.
   */
  const addPasskey = async (): Promise<void> => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    setPasskeyNote(null);
    try {
      if (!window.PublicKeyCredential) {
        throw new Error('This browser does not support passkeys');
      }
      const { options } = await act<{ options: PublicKeyCredentialCreationOptionsJSON }>({
        action: 'passkey-register-options',
      });
      const credential = await navigator.credentials.create({
        publicKey: parseCreationOptionsFromJSON(options),
      });
      if (!credential) throw new Error('No passkey was created');

      await act({
        action: 'passkey-register',
        response: (credential as PublicKeyCredential).toJSON
          ? (credential as unknown as { toJSON: () => unknown }).toJSON()
          : serialiseCredential(credential as PublicKeyCredential),
        label: `${navigator.platform || 'This device'}`.slice(0, 40),
      });
      setPasskeyNote('Passkey registered. You can sign in with it next time.');
      await refresh();
    } catch (problem) {
      // A user who dismisses the system prompt gets an AbortError; that is a
      // decision, not a failure worth shouting about.
      const message =
        problem instanceof Error
          ? problem.name === 'NotAllowedError' || problem.name === 'AbortError'
            ? 'That was cancelled.'
            : problem.message
          : 'Could not register a passkey';
      setPasskeyError(message);
    } finally {
      setPasskeyBusy(false);
    }
  };

  const removeKey = async (credentialId: string): Promise<void> => {
    setPasskeyError(null);
    setPasskeyNote(null);
    try {
      await act({ action: 'passkey-remove', credentialId });
      setPasskeyNote('Passkey removed.');
      await refresh();
    } catch (problem) {
      setPasskeyError(
        problem instanceof Error ? problem.message : 'Could not remove it',
      );
    }
  };

  const exportData = async (): Promise<void> => {
    setDataError(null);
    setDataNote(null);
    try {
      const payload = await act<Record<string, unknown>>({ action: 'export' });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'relay-account-export.json';
      link.click();
      URL.revokeObjectURL(url);
      setDataNote('Export downloaded.');
    } catch (problem) {
      setDataError(problem instanceof Error ? problem.message : 'Could not export');
    }
  };

  const confirmDelete = async (): Promise<void> => {
    setDataError(null);

    /*
     * An account that signs in only with a provider, and has no second
     * factor, has nothing to re-authenticate with: there is no password to
     * type and no code to read. Asking for one anyway left the dialog with a
     * required field nobody could fill. The typed email is a guard against a
     * misclick rather than a proof — the session is the proof, which is the
     * same bar the export below clears.
     */
    if (deleteChallenge === 'email') {
      if (deleteProof.trim().toLowerCase() !== email.trim().toLowerCase()) {
        setDataError('Type the account email exactly as shown to confirm.');
        return;
      }
    }

    setDeleteBusy(true);
    try {
      await act(
        deleteChallenge === 'password'
          ? { action: 'delete', password: deleteProof }
          : deleteChallenge === 'code'
            ? { action: 'delete', code: deleteProof }
            : { action: 'delete' },
      );
      setDeleteOpen(false);
      // The account is gone, so there is nothing left to show: hand control
      // back and let the shell return to the sign-in card.
      onClose();
      await onAccountChanged();
    } catch (problem) {
      setDataError(problem instanceof Error ? problem.message : 'Could not delete it');
    } finally {
      setDeleteBusy(false);
    }
  };

  const account = overview?.user;
  const hasPassword = account?.hasPassword ?? false;
  /** An account open whose overview has not arrived yet. */
  const firstLoad = mode === 'accounts' && !overview && !loadError;
  /*
   * What this account can actually be challenged with, strongest first. A
   * provider-only account has no password, so asking for one is a dead end;
   * with a second factor it can show a code, and with neither the dialog falls
   * back to a typed confirmation.
   */
  const deleteChallenge: 'password' | 'code' | 'email' = hasPassword
    ? 'password'
    : (overview?.mfa.enabled ?? false)
      ? 'code'
      : 'email';

  return (
    <>
      <dialog
        ref={dialogRef}
        className="settingsDialog"
        aria-labelledby="settings-title"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <header className="settingsHead">
          <div>
            <p className="dialogEyebrow">Account</p>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button
            type="button"
            className="dialogClose"
            aria-label="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="settingsBody">
          <section className="settingsCard">
            <h3>Profile</h3>
            <dl className="settingsFacts">
              <div>
                <dt>Signed in as</dt>
                <dd className="truncate">{email}</dd>
              </div>
              <div>
                <dt>Workspace</dt>
                <dd>
                  {mode === 'accounts'
                    ? 'Saved to your account'
                    : mode === 'guest'
                      ? 'Guest — nothing is saved'
                      : mode === 'degraded'
                        ? 'Database offline — nothing is saved'
                        : 'Local mode — no accounts configured'}
                </dd>
              </div>
              {overview ? (
                <>
                  <div>
                    <dt>Member since</dt>
                    <dd>{formatDate(overview.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Sign-in methods</dt>
                    <dd className="methodChips">
                      {overview.signInMethods.length === 0 ? (
                        <span className="hint">None yet</span>
                      ) : (
                        overview.signInMethods.map((method) => (
                          <span className="chip" key={method}>
                            {METHOD_LABELS[method] ?? method}
                          </span>
                        ))
                      )}
                    </dd>
                  </div>
                </>
              ) : null}
            </dl>
            {/* Not while the first fetch is still out: "needs a configured
                database" is wrong, and alarming, when the truth is "one
                moment". */}
            {!overview && !firstLoad ? (
              <p className="notice">
                {mode === 'guest'
                  ? 'You are browsing as a guest. Sign in to get an account you can secure.'
                  : (loadError ??
                    'Account settings need a configured database and a signed-in session.')}
                {mode === 'guest' ? (
                  <>
                    {' '}
                    <button type="button" className="linkButton" onClick={onSignIn}>
                      Sign in
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
          </section>

          {firstLoad
            ? // Placeholders for the three cards that follow, so the dialog
              // opens with its shape rather than filling in from empty.
              ['password', 'security', 'data'].map((card) => (
                <section className="settingsCard" key={card} aria-hidden="true">
                  <div className="settingsSkeleton">
                    <div className="skeletonBar" />
                    <div className="skeletonBar" />
                    <div className="skeletonBar" />
                  </div>
                </section>
              ))
            : null}

          {overview ? (
            <>
              <section className="settingsCard">
                <h3>{hasPassword ? 'Change password' : 'Set a password'}</h3>
                <p className="hint">
                  {hasPassword
                    ? 'Changing it signs out every other device.'
                    : 'This account signs in with a provider. Adding a password gives you a second way in.'}
                </p>
                <form onSubmit={submitPassword}>
                  {hasPassword ? (
                    <div className="dialogField">
                      <label htmlFor="settings-current-password">
                        Current password
                      </label>
                      <PasswordField
                        id="settings-current-password"
                        required
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.target.value)}
                      />
                    </div>
                  ) : null}
                  <div className="dialogField">
                    <label htmlFor="settings-new-password">New password</label>
                    <PasswordField
                      id="settings-new-password"
                      required
                      minLength={10}
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                    />
                  </div>
                  <p className="hint">At least 10 characters. A phrase beats a word.</p>
                  {passwordError ? (
                    <p className="notice bad" role="alert">
                      {passwordError}
                    </p>
                  ) : null}
                  {passwordNote ? (
                    <p className="notice good" role="status">
                      {passwordNote}
                    </p>
                  ) : null}
                  <button type="submit" className="primary" disabled={passwordBusy}>
                    {passwordBusy ? 'Working…' : hasPassword ? 'Change password' : 'Set password'}
                  </button>
                </form>
              </section>

              <section className="settingsCard" data-tour="settings-mfa">
                <h3>Two-factor authentication</h3>
                <p className="settingsStatus">
                  <span
                    className={`badge ${overview.mfa.enabled ? 'good' : 'warn'}`}
                  >
                    {overview.mfa.enabled ? 'On' : 'Off'}
                  </span>
                  {overview.mfa.enabled
                    ? `Enabled ${formatDate(overview.mfa.enabledAt ?? '')} · ${
                        overview.mfa.recoveryRemaining
                      } recovery code${overview.mfa.recoveryRemaining === 1 ? '' : 's'} left`
                    : 'A code from an authenticator app, asked for after your password.'}
                </p>

                {overview.mfa.enabled ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                    }}
                  >
                    <div className="dialogField">
                      <label htmlFor="settings-mfa-proof">
                        {hasPassword
                          ? 'Confirm with your password'
                          : 'Confirm with a current or recovery code'}
                      </label>
                      {hasPassword ? (
                        <PasswordField
                          id="settings-mfa-proof"
                          autoComplete="current-password"
                          value={proof}
                          onChange={(event) => setProof(event.target.value)}
                        />
                      ) : (
                        <input
                          id="settings-mfa-proof"
                          autoComplete="one-time-code"
                          placeholder="123456"
                          value={proof}
                          onChange={(event) => setProof(event.target.value)}
                        />
                      )}
                    </div>
                    {mfaError ? (
                      <p className="notice bad" role="alert">
                        {mfaError}
                      </p>
                    ) : null}
                    {mfaNote ? (
                      <p className="notice good" role="status">
                        {mfaNote}
                      </p>
                    ) : null}
                    {freshCodes ? (
                      <ul className="recoveryCodes">
                        {freshCodes.map((entry) => (
                          <li key={entry}>{entry}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="row">
                      <button
                        type="button"
                        disabled={mfaBusy || proof === ''}
                        onClick={() => void runProofAction('recovery-regenerate')}
                      >
                        Regenerate recovery codes
                      </button>
                      <button
                        type="button"
                        className="destructive"
                        disabled={mfaBusy || proof === ''}
                        onClick={() => void runProofAction('mfa-disable')}
                      >
                        Turn off
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    {mfaNote ? (
                      <p className="notice good" role="status">
                        {mfaNote}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="primary"
                      onClick={() => setMfaOpen(true)}
                    >
                      Turn on two-factor
                    </button>
                  </>
                )}
              </section>

              <section className="settingsCard">
                <h3>Passkeys</h3>
                <p className="hint">
                  A passkey signs you in with the device you already unlock —
                  nothing to type, and nothing phishable, because the credential
                  is bound to this site&rsquo;s origin.
                </p>
                {passkeyNote ? (
                  <p className="notice good" role="status">
                    {passkeyNote}
                  </p>
                ) : null}
                {passkeyError ? (
                  <p className="notice bad" role="alert">
                    {passkeyError}
                  </p>
                ) : null}
                {overview.passkeys.length === 0 ? (
                  <p className="captureEmpty">No passkeys registered.</p>
                ) : (
                  <ul className="cookieList">
                    {overview.passkeys.map((passkey) => (
                      <li key={passkey.credentialId}>
                        <code className="truncate">{passkey.label}</code>
                        <span>added {formatDate(passkey.createdAt)}</span>
                        <span className="cookieFlags">
                          {passkey.lastUsedAt
                            ? `last used ${formatDate(passkey.lastUsedAt)}`
                            : 'never used'}
                        </span>
                        <span />
                        <button
                          type="button"
                          className="iconBtn"
                          aria-label={`Remove ${passkey.label}`}
                          onClick={() => void removeKey(passkey.credentialId)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  disabled={passkeyBusy}
                  onClick={() => void addPasskey()}
                >
                  {passkeyBusy ? 'Waiting for the device…' : 'Add a passkey'}
                </button>
              </section>

              <section className="settingsCard">
                <h3>Other sessions</h3>
                <p className="settingsStatus">
                  {overview.otherSessions === 0
                    ? 'This is the only signed-in device.'
                    : `${overview.otherSessions} other signed-in session${
                        overview.otherSessions === 1 ? '' : 's'
                      }.`}
                </p>
                {sessionNote ? (
                  <p className="notice good" role="status">
                    {sessionNote}
                  </p>
                ) : null}
                <button type="button" onClick={() => void revokeSessions()}>
                  Sign out other devices
                </button>
              </section>
            </>
          ) : null}

          {overview ? (
            <section className="settingsCard">
              <h3>Your data</h3>
              <p className="hint">
                Export hands back every collection and environment this account
                owns. Secret values come out as the ciphertext they are stored
                as — the key never left your browser, so only your passphrase
                can read them back.
              </p>
              {dataNote ? (
                <p className="notice good" role="status">
                  {dataNote}
                </p>
              ) : null}
              {dataError ? (
                <p className="notice bad" role="alert">
                  {dataError}
                </p>
              ) : null}
              <div className="row">
                <button type="button" onClick={() => void exportData()}>
                  Export everything
                </button>
                <button
                  type="button"
                  className="destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete this account
                </button>
              </div>
            </section>
          ) : null}

          <section className="settingsCard">
            <h3>Guided tour</h3>
            <p className="hint">
              A short walk through the relay, the request editor and the analysis
              panels. Safe to replay at any time.
            </p>
            <button
              type="button"
              onClick={() => {
                onClose();
                onStartTour();
              }}
            >
              Start the tour
            </button>
          </section>
        </div>
      </dialog>

      <MfaSetupDialog
        open={mfaOpen}
        onClose={() => setMfaOpen(false)}
        onEnabled={() => {
          setMfaNote('Two-factor authentication is on.');
          return refresh();
        }}
      />

      <AppDialog
        open={deleteOpen}
        eyebrow="Account"
        title="Delete this account?"
        submitLabel="Delete everything"
        tone="danger"
        busy={deleteBusy}
        error={dataError}
        onClose={() => setDeleteOpen(false)}
        onSubmit={() => void confirmDelete()}
      >
        <p className="dialogPrompt">
          Every collection, environment, encrypted secret, passkey and session
          belonging to <strong>{email}</strong> is removed immediately. This
          cannot be undone, and there is no backup.
        </p>
        <div className="dialogField">
          <label htmlFor="delete-proof">
            {deleteChallenge === 'password'
              ? 'Confirm with your password'
              : deleteChallenge === 'code'
                ? 'Confirm with a current or recovery code'
                : 'Type the account email to confirm'}
          </label>
          {deleteChallenge === 'password' ? (
            <PasswordField
              id="delete-proof"
              required
              autoComplete="current-password"
              value={deleteProof}
              onChange={(event) => setDeleteProof(event.target.value)}
            />
          ) : (
            <input
              id="delete-proof"
              required
              autoComplete={deleteChallenge === 'code' ? 'one-time-code' : 'off'}
              {...(deleteChallenge === 'email' ? { placeholder: email } : {})}
              value={deleteProof}
              onChange={(event) => setDeleteProof(event.target.value)}
            />
          )}
          {deleteChallenge === 'email' ? (
            <p className="hint">
              This account signs in with{' '}
              {(overview?.signInMethods ?? [])
                .map((method) => METHOD_LABELS[method] ?? method)
                .join(' and ') || 'a provider'}
              , so there is no password to confirm.
            </p>
          ) : null}
        </div>
      </AppDialog>
    </>
  );
}

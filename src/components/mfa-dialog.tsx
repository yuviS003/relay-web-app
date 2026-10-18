'use client';

import { useEffect, useState } from 'react';

import { AppDialog } from './app-dialog';
import { CodeInput } from './code-input';

type Phase = 'intro' | 'scan' | 'codes';

type Enrollment = { secret: string; uri: string; qr: string };

type MfaSetupDialogProps = {
  open: boolean;
  /** Shows the "Not now" path, used right after signing in or signing up. */
  offerSkip?: boolean;
  onClose: () => void;
  onSkip?: () => void | Promise<void>;
  onEnabled: () => void | Promise<void>;
};

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'That did not work');
  return data;
}

/** Groups a secret for manual entry when a QR code cannot be scanned. */
function spaced(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * Turning on a second factor, in three steps: explain, scan and prove, then
 * hand over the recovery codes.
 *
 * The code is proven before the factor is switched on. Storing the secret as
 * active the moment it is generated is how accounts get locked out by a phone
 * whose clock is wrong or an app that never finished adding the entry.
 */
export function MfaSetupDialog({
  open,
  offerSkip = false,
  onClose,
  onSkip,
  onEnabled,
}: MfaSetupDialogProps) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) return;
    // Nothing from one visit may leak into the next: the secret and the
    // recovery codes are the two things in this app most worth not leaving on
    // screen.
    setPhase('intro');
    setEnrollment(null);
    setCode('');
    setCodes([]);
    setError(null);
    setBusy(false);
    setCopied(false);
  }, [open]);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await post<Enrollment>({ action: 'mfa-start' }));
      setPhase('scan');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not start setup');
    } finally {
      setBusy(false);
    }
  };

  /*
   * Takes the code as an argument rather than reading state.
   *
   * The six-box input reports a finished code in the same tick it reports the
   * change, so a confirm that read `code` from state would send the previous
   * five digits — which failed as "that code is not valid" for a code that was
   * perfectly correct.
   */
  const confirmWith = async (entered: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ codes: string[] }>({
        action: 'mfa-confirm',
        code: entered,
      });
      setCodes(result.codes);
      setPhase('codes');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not turn it on');
    } finally {
      setBusy(false);
    }
  };

  const confirm = (): void => {
    void confirmWith(code);
  };

  const skip = async () => {
    setBusy(true);
    try {
      await onSkip?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    void onEnabled();
    onClose();
  };

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setError('Copying failed. Select the codes and copy them by hand.');
    }
  };

  return (
    <AppDialog
      open={open}
      eyebrow="Security"
      title={
        phase === 'codes'
          ? 'Save your recovery codes'
          : 'Add a second factor'
      }
      description={
        phase === 'intro'
          ? 'A six-digit code from an authenticator app, asked for after your password. Optional, and you can turn it on later from Settings.'
          : phase === 'scan'
            ? 'Scan the code with Google Authenticator, Aegis, 1Password or any TOTP app, then type the six digits it shows.'
            : 'Each code signs you in once if you lose the authenticator. This is the only time they are shown.'
      }
      submitLabel={
        phase === 'intro' ? 'Set it up' : phase === 'scan' ? 'Turn it on' : 'Done'
      }
      size={phase === 'intro' ? 'small' : 'medium'}
      busy={busy}
      error={error}
      onClose={phase === 'codes' ? finish : onClose}
      onSubmit={phase === 'intro' ? begin : phase === 'scan' ? confirm : finish}
    >
      {phase === 'intro' ? (
        <>
          <ul className="factList">
            <li>
              <strong>What it protects</strong>A stolen password alone stops
              being enough to reach your collections and environments.
            </li>
            <li>
              <strong>What you need</strong>Any TOTP authenticator app. No phone
              number, no SMS, nothing sent anywhere.
            </li>
            <li>
              <strong>If you lose it</strong>Eight single-use recovery codes are
              issued at the end.
            </li>
          </ul>
          {offerSkip ? (
            <button
              type="button"
              className="mfaSkip"
              disabled={busy}
              onClick={() => void skip()}
            >
              Not now
              <small>You will not be asked again on sign-in.</small>
            </button>
          ) : null}
        </>
      ) : null}

      {phase === 'scan' && enrollment ? (
        <>
          <div className="mfaScan">
            {/* Server-rendered SVG from a URI this app built; the guard keeps
                an unexpected response out of the DOM. */}
            {enrollment.qr.startsWith('<svg') ? (
              <div
                className="mfaQr"
                role="img"
                aria-label="QR code for your authenticator app"
                dangerouslySetInnerHTML={{ __html: enrollment.qr }}
              />
            ) : null}
            <div className="mfaManual">
              <strong>Cannot scan?</strong>
              <p>Enter this key by hand, with the type set to time-based:</p>
              <code className="mfaSecret">{spaced(enrollment.secret)}</code>
            </div>
          </div>
          <div className="dialogField">
            <label htmlFor="mfa-code">Six-digit code</label>
            <CodeInput
              id="mfa-code"
              label="Six-digit code from your authenticator"
              autoFocus
              disabled={busy}
              invalid={error !== null}
              value={code}
              onChange={setCode}
              // Enrolment is confirmed the moment the sixth digit lands, the
              // same as the sign-in step.
              onComplete={(filled) => void confirmWith(filled)}
            />
          </div>
        </>
      ) : null}

      {phase === 'codes' ? (
        <>
          <ul className="recoveryCodes">
            {codes.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
          <div className="row">
            <button type="button" onClick={() => void copyCodes()}>
              {copied ? 'Copied' : 'Copy codes'}
            </button>
            <a
              className="chip"
              download="relay-recovery-codes.txt"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(
                `Relay recovery codes\n\n${codes.join('\n')}\n`,
              )}`}
            >
              Download
            </a>
          </div>
          <p className="hint">
            Keep them somewhere other than the device running the authenticator.
          </p>
        </>
      ) : null}
    </AppDialog>
  );
}

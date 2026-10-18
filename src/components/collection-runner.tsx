'use client';

import { useEffect, useRef, useState } from 'react';

import { toJUnitXml } from '@/lib/runner/junit';
import { runCollection } from '@/lib/runner/run';
import { relayAttemptFromResponse } from '@/lib/runner/transport';
import type { RunSummary, StepOutcome } from '@/lib/runner/types';
import type { Collection, EnvVariable } from '@/lib/store/types';

type CollectionRunnerProps = {
  open: boolean;
  collection: Collection | null;
  /** Resolves and decrypts the variables a run starts from. */
  getVariables: () => Promise<Record<string, string> | { error: string }>;
  onClose: () => void;
  onSaveVariables: (variables: EnvVariable[]) => Promise<void>;
  canPersist: boolean;
};

type Row = { name: string; value: string };

const MARKS: Record<StepOutcome['status'], string> = {
  passed: '✓',
  failed: '✗',
  blocked: '⊘',
  skipped: '–',
  aborted: '–',
};

function download(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Runs a whole collection in order and reports what happened.
 *
 * Every request still goes through /api/relay one at a time, so a run obeys
 * the same guard, caps and quota as pressing Send — this is orchestration, not
 * a second request path. The report downloads as JUnit so the same collection
 * can gate a pipeline through `npm run collection`.
 */
export function CollectionRunner({
  open,
  collection,
  getVariables,
  onClose,
  onSaveVariables,
  canPersist,
}: CollectionRunnerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [steps, setSteps] = useState<StepOutcome[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bail, setBail] = useState(false);
  const [delayMs, setDelayMs] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [savingVariables, setSavingVariables] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }
    setSteps([]);
    setSummary(null);
    setError(null);
    setRows(
      (collection?.variables ?? [])
        .filter((variable) => !variable.secret)
        .map((variable) => ({ name: variable.name, value: variable.value })),
    );
  }, [open, collection]);

  const start = async (): Promise<void> => {
    if (!collection) return;
    setError(null);

    const resolved = await getVariables();
    if ('error' in resolved) {
      setError(resolved.error);
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setSteps([]);
    setSummary(null);
    setRunning(true);

    const result = await runCollection({
      collection: collection.name,
      requests: collection.requests,
      variables: resolved,
      bail,
      delayMs,
      signal: abort.signal,
      onStep: (step) => setSteps((current) => [...current, step]),
      send: async (payload) => {
        const response = await fetch('/api/relay', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: abort.signal,
        });
        const body = await response.json().catch(() => null);
        return relayAttemptFromResponse(response.status, body);
      },
    });

    setSummary(result);
    setRunning(false);
    abortRef.current = null;
  };

  const saveVariables = async (): Promise<void> => {
    setSavingVariables(true);
    setError(null);
    try {
      const cleaned: EnvVariable[] = rows
        .map((row) => ({
          name: row.name.trim(),
          value: row.value,
          secret: false,
        }))
        .filter((row) => row.name !== '');
      await onSaveVariables(cleaned);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not save them');
    } finally {
      setSavingVariables(false);
    }
  };

  const total = collection?.requests.length ?? 0;

  return (
    <dialog
      ref={dialogRef}
      className="runnerDialog"
      aria-labelledby="runner-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!running) onClose();
      }}
    >
      <header className="settingsHead">
        <div>
          <p className="dialogEyebrow">Collection</p>
          <h2 id="runner-title">Run {collection?.name ?? ''}</h2>
        </div>
        <button
          type="button"
          className="dialogClose"
          aria-label="Close runner"
          disabled={running}
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="settingsBody">
        <section className="settingsCard">
          <h3>Run {total} request{total === 1 ? '' : 's'} in order</h3>
          <p className="hint">
            Each request is sent through the guarded relay, one at a time.
            Values captured from a response become variables the later requests
            can use, so a sign-in step can hand a token to everything after it.
          </p>
          <div className="runnerControls">
            <label className="runnerToggle">
              <input
                type="checkbox"
                checked={bail}
                disabled={running}
                onChange={(event) => setBail(event.target.checked)}
              />
              Stop at the first failure
            </label>
            <label className="runnerDelay">
              Delay between requests
              <input
                type="number"
                min={0}
                max={5000}
                step={50}
                value={delayMs}
                disabled={running}
                onChange={(event) => setDelayMs(Number(event.target.value) || 0)}
              />
              ms
            </label>
            {running ? (
              <button
                type="button"
                className="destructive"
                onClick={() => abortRef.current?.abort()}
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={total === 0}
                onClick={() => void start()}
              >
                Run collection
              </button>
            )}
          </div>
          {error ? (
            <p className="notice bad" role="alert">
              {error}
            </p>
          ) : null}
        </section>

        {steps.length > 0 ? (
          <section className="settingsCard">
            <h3>
              Progress {steps.length}/{total}
            </h3>
            <ol className="runnerSteps">
              {steps.map((step) => (
                <li key={`${step.id}-${step.name}`} className={`runnerStep is-${step.status}`}>
                  <span className="runnerMark" aria-hidden="true">
                    {MARKS[step.status]}
                  </span>
                  <span className="runnerStepBody">
                    <strong>
                      <span className={`verb verb-${step.method}`}>{step.method}</span>{' '}
                      {step.name}
                    </strong>
                    <span className="runnerFacts">
                      <span>{step.httpStatus === null ? '—' : step.httpStatus}</span>
                      <span>{step.durationMs}ms</span>
                      {step.assertions.results.length > 0 ? (
                        <span>
                          {step.assertions.passed}/{step.assertions.results.length}{' '}
                          assertions
                        </span>
                      ) : null}
                    </span>
                    {step.error ? <span className="runnerError">{step.error}</span> : null}
                    {step.assertions.results
                      .filter((result) => !result.ok)
                      .map((result) => (
                        <span className="runnerError" key={result.name}>
                          {result.name}: {result.detail ?? 'failed'}
                        </span>
                      ))}
                    {step.captures.map((capture) => (
                      <span
                        className={capture.ok ? 'runnerCapture' : 'runnerError'}
                        key={capture.name}
                      >
                        {capture.ok
                          ? `captured ${capture.name} = ${capture.value}`
                          : `capture ${capture.name}: ${capture.detail}`}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {summary ? (
          <section className="settingsCard">
            <h3>Result</h3>
            <p className="settingsStatus">
              <span className={`badge ${summary.ok ? 'good' : 'warn'}`}>
                {summary.ok ? 'Passed' : 'Failed'}
              </span>
              {summary.passed}/{summary.total} steps · {summary.assertionsPassed}{' '}
              assertions passed, {summary.assertionsFailed} failed ·{' '}
              {summary.durationMs}ms
            </p>
            <div className="row">
              <button
                type="button"
                onClick={() =>
                  download(
                    `${summary.collection.replace(/\W+/g, '-').toLowerCase()}-junit.xml`,
                    toJUnitXml(summary),
                    'application/xml',
                  )
                }
              >
                Download JUnit
              </button>
              <button
                type="button"
                onClick={() =>
                  download(
                    `${summary.collection.replace(/\W+/g, '-').toLowerCase()}-run.json`,
                    JSON.stringify(summary, null, 2),
                    'application/json',
                  )
                }
              >
                Download JSON
              </button>
            </div>
            <p className="hint">
              The same run is available headless:{' '}
              <code>npm run collection -- --collection file.json --junit out.xml</code>
            </p>
          </section>
        ) : null}

        <section className="settingsCard">
          <h3>Collection variables</h3>
          <p className="hint">
            Shared by every request here, and overridden by the selected
            environment, then by captures and scripts. Use an environment for
            anything secret: these are stored as written.
          </p>
          {rows.map((row, index) => (
            <div className="runnerVariable" key={index}>
              <input
                aria-label={`Variable ${index + 1} name`}
                placeholder="base_url"
                value={row.name}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry, at) =>
                      at === index ? { ...entry, name: event.target.value } : entry,
                    ),
                  )
                }
              />
              <input
                aria-label={`Variable ${index + 1} value`}
                placeholder="https://api.example.com"
                value={row.value}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry, at) =>
                      at === index ? { ...entry, value: event.target.value } : entry,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="iconBtn"
                aria-label={`Remove variable ${index + 1}`}
                onClick={() =>
                  setRows((current) => current.filter((_, at) => at !== index))
                }
              >
                ×
              </button>
            </div>
          ))}
          <div className="row">
            <button
              type="button"
              onClick={() => setRows((current) => [...current, { name: '', value: '' }])}
            >
              Add variable
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canPersist || savingVariables}
              onClick={() => void saveVariables()}
            >
              {savingVariables ? 'Saving…' : 'Save variables'}
            </button>
          </div>
          {!canPersist ? (
            <p className="hint">Sign in to save collection variables.</p>
          ) : null}
        </section>
      </div>
    </dialog>
  );
}

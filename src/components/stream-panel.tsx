'use client';

import { useEffect, useRef, useState } from 'react';

type StreamPanelProps = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** Resolved variables, substituted server-side like any other request. */
  getVariables: () => Promise<Record<string, string> | { error: string }>;
};

type Frame = { at: number; text: string; bytes: number };

type Outcome = {
  ok: boolean;
  status: number | null;
  reason: string | null;
  error: string | null;
  bytes: number;
  durationMs: number;
};

const MAX_FRAMES = 300;

/**
 * Watching a streaming endpoint.
 *
 * Server-sent events and other long responses cannot go through the ordinary
 * relay, which buffers in order to cap what it returns. This talks to the
 * streaming relay instead and appends chunks as they arrive, while the guard,
 * the pinned socket, the byte cap and a bounded time budget all still apply.
 *
 * The frame list is capped: a stream that runs for an hour must not grow the
 * tab's memory by its own length. The byte counter keeps reporting the whole
 * stream regardless.
 */
export function StreamPanel({
  url,
  method,
  headers,
  body,
  getVariables,
}: StreamPanelProps) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async (): Promise<void> => {
    setError(null);
    setFrames([]);
    setOutcome(null);
    setDropped(0);

    const resolved = await getVariables();
    if ('error' in resolved) {
      setError(resolved.error);
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);

    try {
      const response = await fetch('/api/relay/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({ url, method, headers, body, variables: resolved }),
      });

      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error ?? `The relay answered ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';

      // The relay speaks SSE, so frames are separated by a blank line and may
      // arrive split across reads.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });

        let boundary = buffered.indexOf('\n\n');
        while (boundary !== -1) {
          const raw = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          boundary = buffered.indexOf('\n\n');

          const event = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
          const data = /^data: (.*)$/m.exec(raw)?.[1] ?? '';
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event === 'chunk') {
            setFrames((current) => {
              const next = [
                ...current,
                {
                  at: Date.now(),
                  text: String(payload.text ?? ''),
                  bytes: Number(payload.bytes ?? 0),
                },
              ];
              if (next.length > MAX_FRAMES) {
                setDropped((count) => count + next.length - MAX_FRAMES);
                return next.slice(-MAX_FRAMES);
              }
              return next;
            });
          } else if (event === 'done') {
            setOutcome({
              ok: payload.ok === true,
              status: typeof payload.status === 'number' ? payload.status : null,
              reason: typeof payload.reason === 'string' ? payload.reason : null,
              error: typeof payload.error === 'string' ? payload.error : null,
              bytes: Number(payload.bytes ?? 0),
              durationMs: Number(payload.durationMs ?? 0),
            });
          }
        }
      }
    } catch (problem) {
      if ((problem as Error)?.name !== 'AbortError') {
        setError(problem instanceof Error ? problem.message : 'The stream failed');
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="streamPanel">
      <p className="hint">
        Keeps the connection open and shows events as they arrive, for
        server-sent events and other long responses. The same guard, pinned
        address and byte cap apply; only the time budget is longer.
      </p>

      <div className="row">
        {running ? (
          <button
            type="button"
            className="destructive"
            onClick={() => abortRef.current?.abort()}
          >
            Stop streaming
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={url.trim() === ''}
            onClick={() => void start()}
          >
            Start streaming
          </button>
        )}
        {running ? <span className="hint">Listening…</span> : null}
      </div>

      {error ? (
        <p className="notice bad" role="alert">
          {error}
        </p>
      ) : null}

      {outcome ? (
        <p className="settingsStatus">
          <span className={`badge ${outcome.ok ? 'good' : 'warn'}`}>
            {outcome.reason ?? (outcome.ok ? 'closed' : 'failed')}
          </span>
          {outcome.status === null ? '—' : outcome.status} · {outcome.bytes} bytes ·{' '}
          {outcome.durationMs}ms
          {outcome.error ? ` · ${outcome.error}` : ''}
        </p>
      ) : null}

      {frames.length === 0 ? (
        <p className="captureEmpty">No events yet.</p>
      ) : (
        <>
          {dropped > 0 ? (
            <p className="hint">
              {dropped} earlier event{dropped === 1 ? '' : 's'} dropped from this
              view to keep the tab responsive; the byte count is complete.
            </p>
          ) : null}
          {/* Focusable because it scrolls: a region a mouse can scroll and a
              keyboard cannot is an accessibility failure, and axe says so. */}
          <ol className="streamFrames" aria-label="Streamed events" tabIndex={0}>
            {frames.map((frame, index) => (
              <li key={`${frame.at}-${index}`}>
                <span className="streamMeta">{frame.bytes}B</span>
                <pre>{frame.text}</pre>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

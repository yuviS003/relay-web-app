'use client';

import { useMemo, useState } from 'react';

import { diffResponses } from '@/lib/diff';
import type { HistoryEntry } from '@/lib/history/prune';

type HistoryPanelProps = {
  entries: readonly HistoryEntry[];
  /** Limits the list to one request; null shows everything recorded. */
  requestId: string | null;
  onReplay: (entry: HistoryEntry) => void;
  onClear: () => void;
};

function when(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * What this request returned before, and what changed since.
 *
 * Two selected runs are compared structurally when both bodies are JSON, so a
 * re-serialised document with the same values reports no change — a line diff
 * would call every reordered key a difference and bury the one that matters.
 */
export function HistoryPanel({
  entries,
  requestId,
  onReplay,
  onClear,
}: HistoryPanelProps) {
  const [scope, setScope] = useState<'request' | 'all'>('request');
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);

  const visible = useMemo(() => {
    const list =
      scope === 'request' && requestId
        ? entries.filter((entry) => entry.requestId === requestId)
        : entries;
    return [...list].sort((a, b) => b.at - a.at);
  }, [entries, requestId, scope]);

  const diff = useMemo(() => {
    const before = visible.find((entry) => entry.id === left);
    const after = visible.find((entry) => entry.id === right);
    if (!before || !after || before.id === after.id) return null;
    // Older on the left regardless of click order: a diff reads forwards.
    const [from, to] = before.at <= after.at ? [before, after] : [after, before];
    return {
      from,
      to,
      result: diffResponses(
        { status: from.status ?? undefined, durationMs: from.durationMs, headers: from.headers, body: from.body },
        { status: to.status ?? undefined, durationMs: to.durationMs, headers: to.headers, body: to.body },
      ),
    };
  }, [visible, left, right]);

  const toggle = (id: string): void => {
    if (left === id) {
      setLeft(right);
      setRight(null);
      return;
    }
    if (right === id) {
      setRight(null);
      return;
    }
    if (left === null) setLeft(id);
    else setRight(id);
  };

  return (
    <div className="historyPanel">
      <div className="historyBar">
        <div className="chips" role="group" aria-label="History scope">
          <button
            type="button"
            className="chip"
            data-active={scope === 'request'}
            onClick={() => setScope('request')}
          >
            This request
          </button>
          <button
            type="button"
            className="chip"
            data-active={scope === 'all'}
            onClick={() => setScope('all')}
          >
            Everything
          </button>
        </div>
        <button type="button" className="ghost" onClick={onClear}>
          Clear history
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="hint">
          Nothing recorded yet. Every response is kept in this browser —
          bounded, and never sent anywhere — so you can compare a run with the
          one before it.
        </p>
      ) : (
        <>
          <p className="hint">
            Select two runs to compare them. {visible.length} recorded
            {diff ? `, comparing ${when(diff.from.at)} with ${when(diff.to.at)}` : ''}.
          </p>
          <ul className="historyList">
            {visible.map((entry) => {
              const selected = entry.id === left || entry.id === right;
              return (
                <li key={entry.id} className={selected ? 'is-selected' : ''}>
                  <button
                    type="button"
                    className="historyPick"
                    aria-pressed={selected}
                    onClick={() => toggle(entry.id)}
                  >
                    <span className={`verb verb-${entry.method}`}>{entry.method}</span>
                    <span className="truncate">{entry.name}</span>
                    <span className="historyFacts">
                      <span
                        className={`badge ${
                          entry.blocked ? 'warn' : entry.ok ? 'good' : ''
                        }`}
                      >
                        {entry.blocked ? 'blocked' : (entry.status ?? '—')}
                      </span>
                      <span>{entry.durationMs}ms</span>
                      <span>{when(entry.at)}</span>
                      {entry.assertions ? (
                        <span>
                          {entry.assertions.passed}/
                          {entry.assertions.passed + entry.assertions.failed} tests
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => onReplay(entry)}
                    title="Load this URL and method back into the editor"
                  >
                    Restore
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {diff ? (
        <div className="diffView">
          <h3>
            Differences{' '}
            {diff.result.identical ? (
              <span className="badge good">identical</span>
            ) : null}
          </h3>

          <ul className="kvList">
            <li>
              <code>status</code>
              <span>
                {diff.result.status.before ?? '—'} → {diff.result.status.after ?? '—'}
                {diff.result.status.changed ? ' (changed)' : ''}
              </span>
            </li>
            <li>
              <code>duration</code>
              <span>
                {diff.result.durationMs.before ?? '—'}ms →{' '}
                {diff.result.durationMs.after ?? '—'}ms
                {diff.result.durationMs.deltaMs !== null
                  ? ` (${diff.result.durationMs.deltaMs >= 0 ? '+' : ''}${
                      diff.result.durationMs.deltaMs
                    }ms)`
                  : ''}
              </span>
            </li>
          </ul>

          {diff.result.headers.length > 0 ? (
            <>
              <h4>Headers</h4>
              <ul className="diffList">
                {diff.result.headers.map((entry) => (
                  <li key={entry.name} className={`is-${entry.kind}`}>
                    <code>{entry.name}</code>
                    <span>
                      {entry.kind === 'added'
                        ? entry.after
                        : entry.kind === 'removed'
                          ? entry.before
                          : `${entry.before} → ${entry.after}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h4>Body {diff.result.body.mode === 'json' ? '(structural)' : '(lines)'}</h4>
          {diff.result.body.mode === 'json' ? (
            diff.result.body.entries.length === 0 ? (
              <p className="hint">No structural differences.</p>
            ) : (
              <ul className="diffList">
                {diff.result.body.entries.slice(0, 200).map((entry) => (
                  <li key={entry.path} className={`is-${entry.kind}`}>
                    <code>{entry.path}</code>
                    <span>
                      {entry.kind === 'added'
                        ? JSON.stringify(entry.after)
                        : entry.kind === 'removed'
                          ? JSON.stringify(entry.before)
                          : `${JSON.stringify(entry.before)} → ${JSON.stringify(
                              entry.after,
                            )}`}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              {diff.result.body.truncated ? (
                <p className="hint">
                  Too large to compare line by line; shown as a replacement.
                </p>
              ) : null}
              <pre className="diffLines" tabIndex={0}>
                {diff.result.body.rows
                  .slice(0, 400)
                  .map(
                    (row) =>
                      `${row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '} ${row.text}`,
                  )
                  .join('\n')}
              </pre>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

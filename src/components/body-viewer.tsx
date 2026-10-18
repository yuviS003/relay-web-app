'use client';

import { useMemo, useState } from 'react';

import {
  defaultExpanded,
  detectBodyKind,
  hexdump,
  jsonTreeRows,
  type BodyKind,
} from '@/lib/body-view';
import { formatBody } from '@/lib/body-format';
import { JsonPathError, queryJsonPath } from '@/lib/json-path';

type BodyViewerProps = {
  body: string;
  headers: Record<string, string>;
};

type Mode = 'tree' | 'raw' | 'preview' | 'hex';

/**
 * Reading a response body in whatever way it needs to be read.
 *
 * A tree for structure, a path filter sharing its engine with captures, a
 * sandboxed preview for HTML, and a hexdump for anything that is not text.
 * The modes offered depend on what arrived: a hexdump of a JSON document is
 * noise, and a preview of a PDF is a blank frame.
 */
export function BodyViewer({ body, headers }: BodyViewerProps) {
  const kind: BodyKind = useMemo(() => detectBodyKind(headers, body), [headers, body]);
  const parsed = useMemo(() => {
    if (kind !== 'json') return { ok: false as const, value: null };
    try {
      return { ok: true as const, value: JSON.parse(body) as unknown };
    } catch {
      return { ok: false as const, value: null };
    }
  }, [kind, body]);

  const [mode, setMode] = useState<Mode>(kind === 'json' ? 'tree' : 'raw');

  /** How the raw text is shaped: readable, minified, or byte-for-byte. */

  const [rawView, setRawView] = useState<'pretty' | 'minified' | 'exact'>('pretty');
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [initialised, setInitialised] = useState('');

  // Open the first level the first time a given body is shown.
  if (parsed.ok && initialised !== body) {
    setInitialised(body);
    setExpanded(defaultExpanded(parsed.value));
    if (mode === 'hex' || mode === 'preview') setMode('tree');
  }

  const filtered = useMemo(() => {
    if (!parsed.ok || filter.trim() === '') return null;
    try {
      return { ok: true as const, matches: queryJsonPath(parsed.value, filter) };
    } catch (error) {
      return {
        ok: false as const,
        error:
          error instanceof JsonPathError ? error.message : 'That path is not valid',
      };
    }
  }, [parsed, filter]);

  const tree = useMemo(() => {
    if (!parsed.ok) return null;
    return jsonTreeRows(parsed.value, expanded);
  }, [parsed, expanded]);

  const dump = useMemo(() => (mode === 'hex' ? hexdump(body) : null), [mode, body]);

  /*
   * The raw view shows the payload as text, but "raw" should not mean
   * "unreadable": an API that answers on one line is the normal case, and
   * reading it meant copying it elsewhere to indent it. Pretty is the default,
   * with a switch back to exactly what arrived — and a minified form, which is
   * what you want when measuring or pasting a payload somewhere strict.
   */
  const rawShape = useMemo(() => {
    const formatMode: 'json' | 'xml' | 'text' =
      kind === 'json' ? 'json' : kind === 'xml' || kind === 'html' ? 'xml' : 'text';
    const pretty = formatBody(formatMode, body, false);
    const minified = formatBody(formatMode, body, true);
    return {
      // A body that cannot be parsed has no formatted form; the control is
      // hidden rather than offering a no-op.
      pretty: pretty.ok ? pretty.value : null,
      minified: minified.ok ? minified.value : null,
    };
  }, [body, kind]);

  const rawText =
    rawView === 'pretty'
      ? (rawShape.pretty ?? body)
      : rawView === 'minified'
        ? (rawShape.minified ?? body)
        : body;

  const modes: { id: Mode; label: string; available: boolean }[] = [
    { id: 'tree', label: 'Tree', available: parsed.ok },
    { id: 'raw', label: 'Raw', available: true },
    { id: 'preview', label: 'Preview', available: kind === 'html' },
    { id: 'hex', label: 'Hex', available: kind === 'binary' || kind === 'image' || body.length > 0 },
  ];

  return (
    <div className="bodyViewer">
      <div className="bodyViewerBar">
        <div className="chips" role="tablist" aria-label="Body view">
          {modes
            .filter((entry) => entry.available)
            .map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className="chip"
                aria-selected={mode === entry.id}
                data-active={mode === entry.id}
                onClick={() => setMode(entry.id)}
              >
                {entry.label}
              </button>
            ))}
        </div>
        <span className="bodyViewerKind">{kind}</span>
      </div>

      {mode === 'tree' && parsed.ok ? (
        <>
          <div className="bodyFilter">
            <label htmlFor="body-filter">Filter</label>
            <input
              id="body-filter"
              placeholder="$.data.items[0].id"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>

          {filtered && !filtered.ok ? (
            <p className="notice bad" role="alert">
              {filtered.error}
            </p>
          ) : null}

          {filtered?.ok ? (
            <ul className="kvList">
              {filtered.matches.length === 0 ? (
                <li>
                  <code>no match</code>
                  <span>Nothing in this body matches that path.</span>
                </li>
              ) : (
                filtered.matches.map((match) => (
                  <li key={match.path}>
                    <code>{match.path}</code>
                    <span>{JSON.stringify(match.value)}</span>
                  </li>
                ))
              )}
            </ul>
          ) : (
            <ul className="jsonTree" tabIndex={0}>
              {tree?.rows.map((row) => (
                <li
                  key={row.path}
                  style={{ paddingLeft: `${row.depth * 0.9}rem` }}
                  className={`jsonRow is-${row.kind}`}
                >
                  {row.expandable ? (
                    <button
                      type="button"
                      className="jsonToggle"
                      aria-expanded={expanded.has(row.path)}
                      aria-label={`${expanded.has(row.path) ? 'Collapse' : 'Expand'} ${
                        row.label || 'root'
                      }`}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(row.path)) next.delete(row.path);
                          else next.add(row.path);
                          return next;
                        })
                      }
                    >
                      {expanded.has(row.path) ? '▾' : '▸'}
                    </button>
                  ) : (
                    <span className="jsonToggle" aria-hidden="true" />
                  )}
                  <span className="jsonKey">{row.label || '$'}</span>
                  <span className="jsonValue">{row.preview}</span>
                </li>
              ))}
              {tree?.truncated ? (
                <li className="jsonRow">
                  <span className="jsonToggle" />
                  <span className="jsonKey">…</span>
                  <span className="jsonValue">
                    too many nodes to show; filter to narrow it down
                  </span>
                </li>
              ) : null}
            </ul>
          )}
        </>
      ) : null}

      {/* Each of these scrolls, so each is focusable: see the note in
          stream-panel.tsx. */}
      {mode === 'raw' ? (
        <>
          {rawShape.pretty !== null || rawShape.minified !== null ? (
            <div className="chips rawShapes" role="group" aria-label="Raw formatting">
              {(
                [
                  ['pretty', 'Formatted'],
                  ['minified', 'No whitespace'],
                  ['exact', 'Exactly as received'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="chip"
                  aria-pressed={rawView === id}
                  data-active={rawView === id}
                  onClick={() => setRawView(id)}
                >
                  {label}
                </button>
              ))}
              <span className="hint rawSize">{rawText.length} chars</span>
            </div>
          ) : null}
          <pre className="bodyRaw" tabIndex={0}>
            {rawText}
          </pre>
        </>
      ) : null}

      {mode === 'preview' && kind === 'html' ? (
        <>
          <p className="hint">
            Rendered in a sandboxed frame with scripts, forms and same-origin
            access all withheld, so a hostile page cannot reach this one.
          </p>
          <iframe
            className="bodyPreview"
            title="Response preview"
            sandbox=""
            srcDoc={body}
          />
        </>
      ) : null}

      {mode === 'hex' && dump ? (
        <>
          <pre className="bodyHex" tabIndex={0}>
            {dump.lines
              .map((line) => `${line.offset}  ${line.hex}  ${line.ascii}`)
              .join('\n')}
          </pre>
          <p className="hint">
            {dump.byteLength} bytes{dump.truncated ? ', truncated for display' : ''}.
          </p>
        </>
      ) : null}
    </div>
  );
}

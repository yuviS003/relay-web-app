'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

/*
 * Keyboard-first command palette.
 *
 * Every tool a developer already lives in has one, and the API clients mostly
 * do not, which is why reaching for a saved request means hunting a sidebar
 * with the mouse.
 *
 * Matching is subsequence-based rather than substring: typing "pip" should
 * find "Public IP", which `includes` would miss. That is the difference
 * between a palette people use and one they abandon.
 */
function score(query: string, label: string): number | null {
  if (query === '') return 0;

  const needle = query.toLowerCase();
  const haystack = label.toLowerCase();

  let position = 0;
  let gaps = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, position);
    if (found === -1) return null;
    gaps += found - position;
    position = found + 1;
  }
  // Fewer gaps means a tighter match, so a lower score sorts first.
  return gaps;
}

export function CommandPalette({ commands }: { commands: readonly Command[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const scored = commands
      .map((command) => ({ command, rank: score(query, command.label) }))
      .filter(
        (entry): entry is { command: Command; rank: number } => entry.rank !== null,
      )
      .sort((a, b) => a.rank - b.rank);
    return scored.slice(0, 12).map((entry) => entry.command);
  }, [commands, query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Ctrl is honoured alongside Meta so the shortcut works on Linux and
      // Windows, not only macOS.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
        setQuery('');
        setCursor(0);
        return;
      }
      if (event.key === 'Escape') setOpen(false);
    };

    const openPalette = () => {
      setOpen(true);
      setQuery('');
      setCursor(0);
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('wac:open-palette', openPalette);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wac:open-palette', openPalette);
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const choose = useCallback(
    (command: Command | undefined) => {
      if (!command) return;
      setOpen(false);
      command.run();
    },
    [],
  );

  if (!open) return null;

  return (
    <div
      className="paletteBackdrop"
      role="presentation"
      onClick={() => setOpen(false)}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="paletteInput"
          placeholder="Jump to a request or run a command…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setCursor((current) => Math.min(current + 1, matches.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor((current) => Math.max(current - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(matches[cursor]);
            }
          }}
        />

        {matches.length === 0 ? (
          <p className="hint" style={{ margin: '0.6rem 0 0' }}>
            Nothing matches “{query}”.
          </p>
        ) : (
          <ul className="paletteList">
            {matches.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  aria-current={index === cursor}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => choose(command)}
                >
                  <span className="truncate">{command.label}</span>
                  {command.hint ? (
                    <span className="paletteHint">{command.hint}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

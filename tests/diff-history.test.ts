import { describe, expect, it } from 'vitest';

import {
  diffHeaders,
  diffJson,
  diffLines,
  diffResponses,
  LINE_DIFF_LIMIT,
} from '../src/lib/diff';
import {
  capBody,
  pruneHistory,
  type HistoryEntry,
} from '../src/lib/history/prune';

describe('diffJson', () => {
  it('reports added, removed and changed leaves with their paths', () => {
    const entries = diffJson(
      { keep: 1, drop: 2, change: 'a', nested: { same: true, deep: 1 } },
      { keep: 1, add: 3, change: 'b', nested: { same: true, deep: 2 } },
    );
    expect(entries).toEqual([
      { path: '$.add', kind: 'added', after: 3 },
      { path: '$.change', kind: 'changed', before: 'a', after: 'b' },
      { path: '$.drop', kind: 'removed', before: 2 },
      { path: '$.nested.deep', kind: 'changed', before: 1, after: 2 },
    ]);
  });

  it('sees no change when only key order differs', () => {
    expect(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('compares arrays by position and reports length changes', () => {
    expect(diffJson([1, 2, 3], [1, 9, 3, 4])).toEqual([
      { path: '$[1]', kind: 'changed', before: 2, after: 9 },
      { path: '$[3]', kind: 'added', after: 4 },
    ]);
    expect(diffJson([1, 2], [1])).toEqual([
      { path: '$[1]', kind: 'removed', before: 2 },
    ]);
  });

  it('treats a type change as a change of the whole value', () => {
    expect(diffJson({ a: { b: 1 } }, { a: 'text' })).toEqual([
      { path: '$.a', kind: 'changed', before: { b: 1 }, after: 'text' },
    ]);
  });

  it('quotes keys that a dotted path cannot express', () => {
    expect(diffJson({ 'a b': 1 }, { 'a b': 2 })[0]?.path).toBe("$['a b']");
  });

  it('does not report NaN or null as changed against themselves', () => {
    expect(diffJson({ n: Number.NaN, z: null }, { n: Number.NaN, z: null })).toEqual([]);
  });
});

describe('diffLines', () => {
  it('marks additions and removals around common lines', () => {
    const { rows } = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(rows.map((row) => `${row.kind}:${row.text}`)).toEqual([
      'same:a',
      'removed:b',
      'added:B',
      'same:c',
      'added:d',
    ]);
  });

  it('numbers lines on the side that has them', () => {
    const { rows } = diffLines('a', 'a\nb');
    expect(rows[0]).toEqual({ kind: 'same', text: 'a', before: 1, after: 1 });
    expect(rows[1]).toEqual({ kind: 'added', text: 'b', after: 2 });
  });

  it('reports identical text as all-same without computing a table', () => {
    const { rows, truncated } = diffLines('x\ny', 'x\ny');
    expect(truncated).toBe(false);
    expect(rows.every((row) => row.kind === 'same')).toBe(true);
  });

  it('refuses to spend minutes on huge inputs and says so', () => {
    const before = Array.from({ length: LINE_DIFF_LIMIT + 1 }, (_, i) => `a${i}`).join('\n');
    const after = `${before}\nextra`;
    const { rows, truncated } = diffLines(before, after);
    expect(truncated).toBe(true);
    expect(rows.some((row) => row.kind === 'same')).toBe(false);
  });
});

describe('diffHeaders', () => {
  it('folds case and reports only real differences', () => {
    expect(
      diffHeaders(
        { 'Content-Type': 'application/json', 'x-gone': '1', etag: 'a' },
        { 'content-type': 'application/json', 'x-new': '2', ETag: 'b' },
      ),
    ).toEqual([
      { name: 'etag', kind: 'changed', before: 'a', after: 'b' },
      { name: 'x-gone', kind: 'removed', before: '1' },
      { name: 'x-new', kind: 'added', after: '2' },
    ]);
  });

  it('handles a missing side', () => {
    expect(diffHeaders(undefined, { a: '1' })).toEqual([
      { name: 'a', kind: 'added', after: '1' },
    ]);
  });
});

describe('diffResponses', () => {
  it('diffs JSON bodies structurally', () => {
    const diff = diffResponses(
      { status: 200, durationMs: 100, headers: { etag: 'a' }, body: '{"id":1,"v":1}' },
      { status: 200, durationMs: 130, headers: { etag: 'b' }, body: '{"v":2,"id":1}' },
    );
    expect(diff.body.mode).toBe('json');
    expect(diff.body.mode === 'json' && diff.body.entries).toEqual([
      { path: '$.v', kind: 'changed', before: 1, after: 2 },
    ]);
    expect(diff.durationMs.deltaMs).toBe(30);
    expect(diff.status.changed).toBe(false);
    expect(diff.identical).toBe(false);
  });

  it('falls back to lines when either body is not JSON', () => {
    const diff = diffResponses(
      { status: 200, body: '<p>one</p>' },
      { status: 200, body: '<p>two</p>' },
    );
    expect(diff.body.mode).toBe('lines');
  });

  it('calls two identical responses identical', () => {
    const snapshot = {
      status: 200,
      durationMs: 10,
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    };
    expect(diffResponses(snapshot, { ...snapshot, durationMs: 11 }).identical).toBe(true);
  });

  it('notices a status change on its own', () => {
    const diff = diffResponses({ status: 200, body: '{}' }, { status: 500, body: '{}' });
    expect(diff.status).toEqual({ before: 200, after: 500, changed: true });
    expect(diff.identical).toBe(false);
  });
});

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: Math.random().toString(36).slice(2),
    at: 1_000,
    requestId: 'request-1',
    name: 'Request',
    method: 'GET',
    url: 'https://api.example/x',
    status: 200,
    ok: true,
    blocked: false,
    durationMs: 10,
    bodyBytes: 2,
    body: '{}',
    bodyTruncated: false,
    headers: {},
    assertions: null,
    ...overrides,
  };
}

describe('history retention', () => {
  it('caps a stored body and says it was cut', () => {
    expect(capBody('abcdef', 3)).toEqual({ body: 'abc', truncated: true });
    expect(capBody('ab', 3)).toEqual({ body: 'ab', truncated: false });
  });

  it('keeps the newest entries up to the count limit', () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      entry({ id: `e${index}`, at: index }),
    );
    expect(pruneHistory(entries, { maxEntries: 3 }).map((item) => item.id)).toEqual([
      'e4',
      'e3',
      'e2',
    ]);
  });

  it('stops adding once the byte budget is spent', () => {
    const big = 'x'.repeat(1000);
    const entries = [
      entry({ id: 'new', at: 3, body: big }),
      entry({ id: 'mid', at: 2, body: big }),
      entry({ id: 'old', at: 1, body: big }),
    ];
    const kept = pruneHistory(entries, { maxTotalBytes: 2500 });
    expect(kept.map((item) => item.id)).toEqual(['new', 'mid']);
  });

  it('always keeps the newest entry, even when it alone blows the budget', () => {
    const kept = pruneHistory(
      [entry({ id: 'huge', at: 2, body: 'x'.repeat(10_000) }), entry({ id: 'old', at: 1 })],
      { maxTotalBytes: 100 },
    );
    expect(kept.map((item) => item.id)).toEqual(['huge']);
  });

  it('does not mutate what it was given', () => {
    const entries = [entry({ id: 'a', at: 1 }), entry({ id: 'b', at: 2 })];
    const copy = [...entries];
    pruneHistory(entries, { maxEntries: 1 });
    expect(entries).toEqual(copy);
  });

  it('orders a mixed set newest first regardless of how it arrived', () => {
    const kept = pruneHistory([
      entry({ id: 'middle', at: 2 }),
      entry({ id: 'newest', at: 3 }),
      entry({ id: 'oldest', at: 1 }),
    ]);
    expect(kept.map((item) => item.id)).toEqual(['newest', 'middle', 'oldest']);
  });
});

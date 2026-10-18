/*
 * Comparing two responses.
 *
 * Two kinds of comparison, because two kinds of question. "What changed in the
 * payload" is answered structurally: a key that moved in a re-serialised JSON
 * document is not a change, and a line diff would claim it was. "What changed
 * in this text" is answered by lines, for everything that is not JSON.
 *
 * The line diff is a plain LCS table rather than Myers. It is quadratic, so it
 * is capped: past the cap the honest answer is "replaced", not a diff computed
 * for a minute while the tab freezes.
 */

export type JsonDiffKind = 'added' | 'removed' | 'changed';

export type JsonDiffEntry = {
  path: string;
  kind: JsonDiffKind;
  before?: unknown;
  after?: unknown;
};

export type LineDiffKind = 'same' | 'added' | 'removed';

export type LineDiffRow = {
  kind: LineDiffKind;
  text: string;
  /** 1-based line numbers, absent on the side that does not have the line. */
  before?: number;
  after?: number;
};

export type HeaderDiffEntry = {
  name: string;
  kind: JsonDiffKind;
  // Spelled `| undefined` because one side is genuinely absent for an added
  // or removed header, and exactOptionalPropertyTypes distinguishes the two.
  before?: string | undefined;
  after?: string | undefined;
};

export const LINE_DIFF_LIMIT = 1500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function segment(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}['${key.replace(/'/g, "\\'")}']`;
}

function sameScalar(a: unknown, b: unknown): boolean {
  // Object.is so NaN compares equal to NaN rather than reporting a change in
  // every response that contains one.
  return Object.is(a, b);
}

/** A structural diff of two parsed JSON documents. */
export function diffJson(before: unknown, after: unknown): JsonDiffEntry[] {
  const entries: JsonDiffEntry[] = [];

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (sameScalar(a, b)) return;

    if (Array.isArray(a) && Array.isArray(b)) {
      const length = Math.max(a.length, b.length);
      for (let index = 0; index < length; index += 1) {
        const childPath = `${path}[${index}]`;
        if (index >= a.length) {
          entries.push({ path: childPath, kind: 'added', after: b[index] });
        } else if (index >= b.length) {
          entries.push({ path: childPath, kind: 'removed', before: a[index] });
        } else {
          walk(a[index], b[index], childPath);
        }
      }
      return;
    }

    if (isRecord(a) && isRecord(b)) {
      // Union of keys, in a stable order, so the report does not depend on
      // whichever document happened to be serialised first.
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const childPath = segment(path, key);
        const inA = Object.prototype.hasOwnProperty.call(a, key);
        const inB = Object.prototype.hasOwnProperty.call(b, key);
        if (!inA) entries.push({ path: childPath, kind: 'added', after: b[key] });
        else if (!inB) entries.push({ path: childPath, kind: 'removed', before: a[key] });
        else walk(a[key], b[key], childPath);
      }
      return;
    }

    entries.push({ path, kind: 'changed', before: a, after: b });
  };

  walk(before, after, '$');
  return entries;
}

/**
 * A line diff. `truncated` means the inputs were too large to compare line by
 * line, and the rows describe a wholesale replacement instead.
 */
export function diffLines(
  before: string,
  after: string,
): { rows: LineDiffRow[]; truncated: boolean } {
  if (before === after) {
    return {
      rows: before.split('\n').map((text, index) => ({
        kind: 'same' as const,
        text,
        before: index + 1,
        after: index + 1,
      })),
      truncated: false,
    };
  }

  const left = before.split('\n');
  const right = after.split('\n');

  if (left.length > LINE_DIFF_LIMIT || right.length > LINE_DIFF_LIMIT) {
    return {
      rows: [
        ...left.map((text, index) => ({
          kind: 'removed' as const,
          text,
          before: index + 1,
        })),
        ...right.map((text, index) => ({
          kind: 'added' as const,
          text,
          after: index + 1,
        })),
      ],
      truncated: true,
    };
  }

  // Longest common subsequence table, then a walk back through it.
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j]
          ? (table[i + 1]![j + 1] ?? 0) + 1
          : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }

  const rows: LineDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      rows.push({ kind: 'same', text: left[i]!, before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      rows.push({ kind: 'removed', text: left[i]!, before: i + 1 });
      i += 1;
    } else {
      rows.push({ kind: 'added', text: right[j]!, after: j + 1 });
      j += 1;
    }
  }
  while (i < left.length) {
    rows.push({ kind: 'removed', text: left[i]!, before: i + 1 });
    i += 1;
  }
  while (j < right.length) {
    rows.push({ kind: 'added', text: right[j]!, after: j + 1 });
    j += 1;
  }

  return { rows, truncated: false };
}

/** Header names are case-insensitive, so they are compared folded. */
export function diffHeaders(
  before: Record<string, string> = {},
  after: Record<string, string> = {},
): HeaderDiffEntry[] {
  const fold = (headers: Record<string, string>): Map<string, string> => {
    const folded = new Map<string, string>();
    for (const [name, value] of Object.entries(headers)) {
      folded.set(name.toLowerCase(), value);
    }
    return folded;
  };

  const left = fold(before);
  const right = fold(after);
  const entries: HeaderDiffEntry[] = [];

  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(name);
    const b = right.get(name);
    if (a === b) continue;
    if (a === undefined) entries.push({ name, kind: 'added', after: b });
    else if (b === undefined) entries.push({ name, kind: 'removed', before: a });
    else entries.push({ name, kind: 'changed', before: a, after: b });
  }

  return entries;
}

export type ResponseSnapshot = {
  status?: number | undefined;
  durationMs?: number | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
};

export type ResponseDiff = {
  status: { before: number | null; after: number | null; changed: boolean };
  durationMs: { before: number | null; after: number | null; deltaMs: number | null };
  headers: HeaderDiffEntry[];
  /** Structural when both bodies parse as JSON, lines otherwise. */
  body:
    | { mode: 'json'; entries: JsonDiffEntry[] }
    | { mode: 'lines'; rows: LineDiffRow[]; truncated: boolean };
  identical: boolean;
};

function parseJson(text: string | undefined): { ok: boolean; value: unknown } {
  if (text === undefined || text.trim() === '') return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

export function diffResponses(
  before: ResponseSnapshot,
  after: ResponseSnapshot,
): ResponseDiff {
  const headers = diffHeaders(before.headers, after.headers);
  const left = parseJson(before.body);
  const right = parseJson(after.body);

  const body: ResponseDiff['body'] =
    left.ok && right.ok
      ? { mode: 'json', entries: diffJson(left.value, right.value) }
      : { mode: 'lines', ...diffLines(before.body ?? '', after.body ?? '') };

  const statusBefore = before.status ?? null;
  const statusAfter = after.status ?? null;
  const bodyChanged =
    body.mode === 'json'
      ? body.entries.length > 0
      : body.rows.some((row) => row.kind !== 'same');

  return {
    status: {
      before: statusBefore,
      after: statusAfter,
      changed: statusBefore !== statusAfter,
    },
    durationMs: {
      before: before.durationMs ?? null,
      after: after.durationMs ?? null,
      deltaMs:
        before.durationMs === undefined || after.durationMs === undefined
          ? null
          : after.durationMs - before.durationMs,
    },
    headers,
    body,
    identical: statusBefore === statusAfter && headers.length === 0 && !bodyChanged,
  };
}

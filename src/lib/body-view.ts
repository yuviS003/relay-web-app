/*
 * Reading a response body.
 *
 * Four questions, four answers: what kind of payload is this, what does the
 * structure look like (a tree, not 400 KB of one line), what are the actual
 * bytes (a hexdump, for anything binary or suspiciously encoded), and how do I
 * narrow it down (a path filter, sharing lib/json-path.ts with captures).
 */

export type BodyKind = 'json' | 'html' | 'xml' | 'image' | 'binary' | 'text' | 'empty';

const IMAGE = /^image\//i;
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i;

/** Control characters that no text payload should be full of. */
function looksBinary(body: string): boolean {
  const sample = body.slice(0, 512);
  if (sample === '') return false;
  let suspicious = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 0xfffd) suspicious += 1;
  }
  return suspicious / sample.length > 0.1;
}

export function detectBodyKind(
  headers: Record<string, string> = {},
  body = '',
): BodyKind {
  if (body === '') return 'empty';

  const contentType =
    Object.entries(headers)
      .find(([name]) => name.toLowerCase() === 'content-type')?.[1]
      ?.toLowerCase() ?? '';

  if (IMAGE.test(contentType)) return 'image';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('html')) return 'html';
  if (contentType.includes('xml')) return 'xml';

  // An unhelpful or absent content type is common, so sniff rather than guess.
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(body);
      return 'json';
    } catch {
      // Not JSON after all; fall through to the other sniffs.
    }
  }
  if (/^<!doctype html|^<html/i.test(trimmed)) return 'html';
  if (trimmed.startsWith('<?xml') || /^<[a-z][\w:-]*[\s>]/i.test(trimmed)) return 'xml';
  if (!TEXTUAL.test(contentType) && looksBinary(body)) return 'binary';
  return 'text';
}

export type HexLine = { offset: string; hex: string; ascii: string };

export const HEXDUMP_LIMIT = 8 * 1024;

/**
 * A classic offset/hex/ascii dump, capped.
 *
 * Bytes come from the body's UTF-16 code units masked to a byte, which is what
 * the relay already handed us; a faithful decode would need the original
 * bytes, and this is a diagnostic view, not a parser.
 */
export function hexdump(
  body: string,
  options: { limit?: number; width?: number } = {},
): { lines: HexLine[]; truncated: boolean; byteLength: number } {
  const limit = options.limit ?? HEXDUMP_LIMIT;
  const width = options.width ?? 16;
  const bytes: number[] = [];
  for (let index = 0; index < Math.min(body.length, limit); index += 1) {
    bytes.push(body.charCodeAt(index) & 0xff);
  }

  const lines: HexLine[] = [];
  for (let start = 0; start < bytes.length; start += width) {
    const chunk = bytes.slice(start, start + width);
    lines.push({
      offset: start.toString(16).padStart(8, '0'),
      hex: chunk
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(width * 3 - 1, ' '),
      ascii: chunk
        .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.'))
        .join(''),
    });
  }

  return { lines, truncated: body.length > limit, byteLength: body.length };
}

export type TreeRow = {
  path: string;
  /** The key or index as written, '' for the root. */
  label: string;
  depth: number;
  kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  /** A short rendering of the value, or a size for a container. */
  preview: string;
  expandable: boolean;
};

const PREVIEW_LIMIT = 80;

function kindOf(value: unknown): TreeRow['kind'] {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

function previewOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value as object).length}}`;
  }
  if (typeof value === 'string') {
    return value.length > PREVIEW_LIMIT
      ? `"${value.slice(0, PREVIEW_LIMIT)}…"`
      : `"${value}"`;
  }
  return String(value);
}

function segment(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)
    ? `${path}.${key}`
    : `${path}['${key.replace(/'/g, "\\'")}']`;
}

export const TREE_ROW_LIMIT = 2000;

/**
 * Flattens a document into rows for a tree, honouring which paths are open.
 *
 * Flat rather than nested so the view can render a long list without recursing
 * in the component, and capped so a 50 MB array cannot lock the tab.
 */
export function jsonTreeRows(
  value: unknown,
  expanded: ReadonlySet<string>,
  limit = TREE_ROW_LIMIT,
): { rows: TreeRow[]; truncated: boolean } {
  const rows: TreeRow[] = [];
  let truncated = false;

  const walk = (current: unknown, path: string, label: string, depth: number): void => {
    if (rows.length >= limit) {
      truncated = true;
      return;
    }
    const kind = kindOf(current);
    const expandable = kind === 'object' || kind === 'array';
    rows.push({ path, label, depth, kind, preview: previewOf(current), expandable });

    if (!expandable || !expanded.has(path)) return;

    if (Array.isArray(current)) {
      current.forEach((entry, index) =>
        walk(entry, `${path}[${index}]`, String(index), depth + 1),
      );
      return;
    }
    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      walk(entry, segment(path, key), key, depth + 1);
    }
  };

  walk(value, '$', '', 0);
  return { rows, truncated };
}

/** Paths worth opening by default: the root and its immediate containers. */
export function defaultExpanded(value: unknown): Set<string> {
  const open = new Set<string>(['$']);
  if (Array.isArray(value)) {
    if (value.length > 0) open.add('$[0]');
    return open;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry && typeof entry === 'object') open.add(segment('$', key));
    }
  }
  return open;
}

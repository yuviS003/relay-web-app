import type { BodyMode } from '@/lib/store/types';

export type FormatResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

function ok(value: string): FormatResult {
  return { ok: true, value };
}

function fail(error: string): FormatResult {
  return { ok: false, error };
}

function json(body: string, compact: boolean): FormatResult {
  try {
    return ok(JSON.stringify(JSON.parse(body), null, compact ? 0 : 2));
  } catch (error) {
    return fail(error instanceof Error ? `Invalid JSON: ${error.message}` : 'Invalid JSON');
  }
}

/** Small dependency-free XML formatter; validation still uses DOMParser in-browser. */
function xml(body: string, compact: boolean): FormatResult {
  const source = body.trim();
  if (source === '') return ok('');
  if (typeof DOMParser !== 'undefined') {
    const parsed = new DOMParser().parseFromString(source, 'application/xml');
    if (parsed.querySelector('parsererror')) return fail('Invalid XML. Fix the markup before formatting.');
  }
  if (compact) return ok(source.replace(/>\s+</g, '><'));

  const tokens = source.replace(/>\s*</g, '>\n<').trim().split('\n');
  let depth = 0;
  const lines: string[] = [];
  for (const token of tokens) {
    const trimmed = token.trim();
    if (/^<\//.test(trimmed)) depth = Math.max(0, depth - 1);
    lines.push(`${'  '.repeat(depth)}${trimmed}`);
    if (
      /^<[^!?/][^>]*>$/.test(trimmed) &&
      !/\/>$/.test(trimmed) &&
      !/<\/[^>]+>$/.test(trimmed)
    ) {
      depth += 1;
    }
  }
  return ok(lines.join('\n'));
}

function form(body: string): FormatResult {
  try {
    const entries = [...new URLSearchParams(body.replace(/\s*&\s*/g, '&'))];
    return ok(new URLSearchParams(entries).toString());
  } catch {
    return fail('Invalid form URL-encoded body.');
  }
}

function text(body: string, compact: boolean): FormatResult {
  const lines = body.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());
  return ok(compact ? lines.map((line) => line.trim()).filter(Boolean).join(' ') : lines.join('\n').trim());
}

export function formatBody(mode: BodyMode, body: string, compact = false): FormatResult {
  switch (mode) {
    case 'json':
      return json(body, compact);
    case 'xml':
      return xml(body, compact);
    case 'form':
      return form(body);
    case 'text':
      return text(body, compact);
    case 'none':
      return ok('');
  }
}

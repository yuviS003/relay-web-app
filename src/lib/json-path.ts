/*
 * A small JSON path reader.
 *
 * Used in two places that must agree: capturing a value out of one response to
 * feed the next request in a collection run, and filtering a body in the
 * response viewer. A single implementation means a path that works in the
 * viewer works in a capture.
 *
 * Deliberately a subset of JSONPath, and deliberately not an expression
 * language. Filters like `$.items[?(@.price > 10)]` need an evaluator, and an
 * evaluator over untrusted text is how a convenience feature becomes an
 * injection surface. Supported:
 *
 *   $.a.b          dot steps, with or without the leading $
 *   a[0]           array index, negative counts from the end
 *   a[*] / a.*     every element or value at that level
 *   $..name        recursive descent to every `name` at any depth
 *   a['b-c']       bracketed key for names dots cannot express
 *   $              the document itself
 */

export type JsonPathStep =
  | { kind: 'key'; name: string }
  | { kind: 'index'; at: number }
  | { kind: 'wildcard' }
  | { kind: 'descend'; name: string };

export type JsonPathMatch = { path: string; value: unknown };

export class JsonPathError extends Error {}

const KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/** Parses a path into steps, or throws JsonPathError with the reason. */
export function parseJsonPath(input: string): JsonPathStep[] {
  const steps: JsonPathStep[] = [];
  let rest = input.trim();
  if (rest === '') throw new JsonPathError('Path is empty');
  if (rest === '$' || rest === '$.') return steps;
  if (rest.startsWith('$')) rest = rest.slice(1);

  let guard = 0;
  while (rest !== '') {
    if (guard++ > 512) throw new JsonPathError('Path is too long');

    if (rest.startsWith('..')) {
      const after = rest.slice(2);
      const name = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(after)?.[0];
      if (!name) throw new JsonPathError('Expected a name after ".."');
      steps.push({ kind: 'descend', name });
      rest = after.slice(name.length);
      continue;
    }

    if (rest.startsWith('.')) {
      const after = rest.slice(1);
      if (after.startsWith('*')) {
        steps.push({ kind: 'wildcard' });
        rest = after.slice(1);
        continue;
      }
      const name = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(after)?.[0];
      if (!name) throw new JsonPathError('Expected a property name after "."');
      steps.push({ kind: 'key', name });
      rest = after.slice(name.length);
      continue;
    }

    if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      if (close === -1) throw new JsonPathError('Unclosed "["');
      const inner = rest.slice(1, close).trim();
      rest = rest.slice(close + 1);

      if (inner === '*') {
        steps.push({ kind: 'wildcard' });
        continue;
      }
      const quoted = /^'(.*)'$|^"(.*)"$/.exec(inner);
      if (quoted) {
        steps.push({ kind: 'key', name: quoted[1] ?? quoted[2] ?? '' });
        continue;
      }
      if (!/^-?\d+$/.test(inner)) {
        throw new JsonPathError(`"${inner}" is not an index or a quoted key`);
      }
      steps.push({ kind: 'index', at: Number(inner) });
      continue;
    }

    // A bare leading name, so "data.id" works as well as "$.data.id".
    const name = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(rest)?.[0];
    if (!name) throw new JsonPathError(`Unexpected "${rest[0]}" in path`);
    steps.push({ kind: 'key', name });
    rest = rest.slice(name.length);
  }

  return steps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoteSegment(name: string): string {
  return KEY.test(name) ? `.${name}` : `['${name.replace(/'/g, "\\'")}']`;
}

function descend(value: unknown, name: string, path: string, into: JsonPathMatch[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => descend(entry, name, `${path}[${index}]`, into));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}${quoteSegment(key)}`;
    if (key === name) into.push({ path: childPath, value: entry });
    descend(entry, name, childPath, into);
  }
}

/** Every match for `path` inside `document`, with the concrete path of each. */
export function queryJsonPath(document: unknown, path: string): JsonPathMatch[] {
  const steps = parseJsonPath(path);
  let current: JsonPathMatch[] = [{ path: '$', value: document }];

  for (const step of steps) {
    const next: JsonPathMatch[] = [];
    for (const match of current) {
      switch (step.kind) {
        case 'key': {
          if (isRecord(match.value) && step.name in match.value) {
            next.push({
              path: `${match.path}${quoteSegment(step.name)}`,
              value: match.value[step.name],
            });
          }
          break;
        }
        case 'index': {
          if (Array.isArray(match.value)) {
            const at = step.at < 0 ? match.value.length + step.at : step.at;
            if (at >= 0 && at < match.value.length) {
              next.push({ path: `${match.path}[${at}]`, value: match.value[at] });
            }
          }
          break;
        }
        case 'wildcard': {
          if (Array.isArray(match.value)) {
            match.value.forEach((value, index) =>
              next.push({ path: `${match.path}[${index}]`, value }),
            );
          } else if (isRecord(match.value)) {
            for (const [key, value] of Object.entries(match.value)) {
              next.push({ path: `${match.path}${quoteSegment(key)}`, value });
            }
          }
          break;
        }
        case 'descend': {
          descend(match.value, step.name, match.path, next);
          break;
        }
      }
    }
    current = next;
    if (current.length === 0) break;
  }

  return current;
}

/**
 * The single value a capture should take, as a string.
 *
 * A capture feeds a {{variable}}, which is substituted into text, so an object
 * or array match is serialised rather than stringified to "[object Object]".
 * No match is null, which the caller reports as a failed capture instead of
 * quietly writing an empty variable.
 */
export function readJsonPathValue(document: unknown, path: string): string | null {
  const [first] = queryJsonPath(document, path);
  if (!first) return null;
  const { value } = first;
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
    case 'object':
      return JSON.stringify(value);
    default:
      return null;
  }
}

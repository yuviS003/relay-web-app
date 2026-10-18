import { defaultHeaders } from '../request-defaults';
import type { HeaderPair, RequestSpec } from '../store/types';

/*
 * OpenAPI 3 to a collection.
 *
 * Imports what is actually useful to send: method, URL with the server
 * prefix, header and query parameters with their examples, and a body
 * skeleton derived from the request schema. Path templates become Relay
 * variables, so `/users/{id}` arrives as `/users/{{id}}` and the Vars tab can
 * report it as unset rather than sending a literal brace.
 *
 * JSON only. YAML would mean a parser dependency for a format the user can
 * convert in one command, and a half-working YAML reader is worse than a clear
 * "convert it first".
 *
 * Nothing here trusts the document: it is third-party input, so every field is
 * checked and anything unusable is reported as a warning instead of throwing
 * the whole import away.
 */

export type ImportedRequest = Omit<RequestSpec, 'id'>;

export type ImportResult = {
  name: string;
  requests: ImportedRequest[];
  warnings: string[];
};

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;
const MAX_REQUESTS = 200;
const MAX_SCHEMA_DEPTH = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Resolves a local $ref, with a visited set so a cycle cannot hang. */
function deref(
  document: Record<string, unknown>,
  value: unknown,
  seen: Set<string> = new Set(),
): unknown {
  if (!isRecord(value)) return value;
  const ref = text(value.$ref);
  if (!ref) return value;
  if (!ref.startsWith('#/') || seen.has(ref)) return {};
  seen.add(ref);

  let current: unknown = document;
  for (const segment of ref.slice(2).split('/')) {
    if (!isRecord(current)) return {};
    current = current[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return deref(document, current, seen);
}

/**
 * A minimal value that satisfies a schema, for a body the user can edit.
 *
 * `refs` carries the $refs already open on this path, so a self-referential
 * schema stops at the second visit instead of being unrolled to the depth
 * limit: `{ "self": null }` describes a recursive field far better than six
 * nested copies of it.
 */
function sampleFor(
  document: Record<string, unknown>,
  schemaInput: unknown,
  depth = 0,
  refs: ReadonlySet<string> = new Set(),
): unknown {
  let openRefs = refs;
  if (isRecord(schemaInput)) {
    const ref = text(schemaInput.$ref);
    if (ref) {
      if (refs.has(ref)) return null;
      openRefs = new Set([...refs, ref]);
    }
  }

  const schema = deref(document, schemaInput);
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH) return null;

  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;

  const composed = ['allOf', 'oneOf', 'anyOf'].find((key) => Array.isArray(schema[key]));
  if (composed) {
    const branches = schema[composed] as unknown[];
    if (composed === 'allOf') {
      return branches.reduce<Record<string, unknown>>((merged, branch) => {
        const value = sampleFor(document, branch, depth + 1, openRefs);
        return isRecord(value) ? { ...merged, ...value } : merged;
      }, {});
    }
    return sampleFor(document, branches[0], depth + 1, openRefs);
  }

  const type = text(schema.type) ?? (isRecord(schema.properties) ? 'object' : null);
  switch (type) {
    case 'object': {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const sample: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(properties)) {
        sample[name] = sampleFor(document, property, depth + 1, openRefs);
      }
      return sample;
    }
    case 'array':
      return [sampleFor(document, schema.items, depth + 1, openRefs)].filter(
        (entry) => entry !== null || depth === 0,
      );
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string': {
      const format = text(schema.format);
      if (format === 'date-time') return '1970-01-01T00:00:00Z';
      if (format === 'date') return '1970-01-01';
      if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      return '';
    }
    default:
      return null;
  }
}

/** `/users/{id}` becomes `/users/{{id}}` so the path parameter is a variable. */
function templatePath(path: string): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{{$1}}');
}

function serverUrl(document: Record<string, unknown>, warnings: string[]): string {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const first = servers.find(isRecord);
  const url = first ? text(first.url) : null;
  if (!url) {
    warnings.push('No server URL in the document; URLs are relative and need a host.');
    return '';
  }
  if (url.includes('{')) {
    warnings.push(
      `Server URL "${url}" has template variables; they were kept as {{variables}}.`,
    );
  }
  return templatePath(url.replace(/\/$/, ''));
}

export function importOpenApi(input: unknown): ImportResult {
  const warnings: string[] = [];
  if (!isRecord(input)) {
    return { name: 'Imported', requests: [], warnings: ['That file is not a JSON object.'] };
  }

  const version = text(input.openapi) ?? text(input.swagger);
  if (!version) {
    warnings.push('No "openapi" version field; importing on a best-effort basis.');
  } else if (version.startsWith('2')) {
    warnings.push(
      'This is a Swagger 2.0 document. Paths and parameters import; bodies may not.',
    );
  }

  const info = isRecord(input.info) ? input.info : {};
  const name = text(info.title) ?? 'Imported API';
  const base = serverUrl(input, warnings);
  const paths = isRecord(input.paths) ? input.paths : {};
  const requests: ImportedRequest[] = [];

  for (const [path, pathItemInput] of Object.entries(paths)) {
    const pathItem = deref(input, pathItemInput);
    if (!isRecord(pathItem)) continue;

    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      if (requests.length >= MAX_REQUESTS) {
        warnings.push(`Stopped at ${MAX_REQUESTS} requests; the rest were skipped.`);
        return { name, requests, warnings };
      }

      const parameters = [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
        .map((parameter) => deref(input, parameter))
        .filter(isRecord);

      const query: string[] = [];
      const headers: HeaderPair[] = [];

      for (const parameter of parameters) {
        const parameterName = text(parameter.name);
        if (!parameterName) continue;
        const where = text(parameter.in);
        const example =
          parameter.example !== undefined
            ? String(parameter.example)
            : `{{${parameterName.replace(/[^A-Za-z0-9_]/g, '_')}}}`;

        if (where === 'query') {
          // Required parameters are prefilled; optional ones would make every
          // URL a wall of empty values.
          if (parameter.required === true) {
            query.push(`${encodeURIComponent(parameterName)}=${example}`);
          }
        } else if (where === 'header' && parameterName.toLowerCase() !== 'authorization') {
          headers.push({ name: parameterName.toLowerCase(), value: example, enabled: true });
        }
      }

      const upper = method.toUpperCase();
      let body = '';
      const requestBody = deref(input, operation.requestBody);
      if (isRecord(requestBody)) {
        const content = isRecord(requestBody.content) ? requestBody.content : {};
        const jsonEntry = Object.entries(content).find(([type]) =>
          type.toLowerCase().includes('json'),
        );
        if (jsonEntry) {
          const media = isRecord(jsonEntry[1]) ? jsonEntry[1] : {};
          const sample =
            media.example !== undefined
              ? media.example
              : sampleFor(input, media.schema);
          body = JSON.stringify(sample ?? {}, null, 2);
        } else if (Object.keys(content).length > 0) {
          warnings.push(
            `${upper} ${path} takes ${Object.keys(content)[0]}, which was left empty.`,
          );
        }
      }

      const defaults = defaultHeaders(upper);
      const merged: HeaderPair[] = [...defaults];
      for (const header of headers) {
        if (!merged.some((entry) => entry.name === header.name)) merged.push(header);
      }

      requests.push({
        name:
          text(operation.operationId) ??
          text(operation.summary) ??
          `${upper} ${path}`,
        method: upper,
        url: `${base}${templatePath(path)}${query.length > 0 ? `?${query.join('&')}` : ''}`,
        headers: merged,
        body,
        ...(body !== '' ? { bodyMode: 'json' as const } : {}),
        preRequestScript: '',
        testScript: '',
      });
    }
  }

  if (requests.length === 0) {
    warnings.push('No operations were found under "paths".');
  }

  return { name, requests, warnings };
}

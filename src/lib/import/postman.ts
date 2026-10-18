import type { HeaderPair } from '../store/types';
import type { ImportedRequest, ImportResult } from './openapi';

/*
 * Postman collection v2.1 to a collection.
 *
 * Postman already writes {{variables}} the same way, so URLs and headers come
 * across unchanged. Folders are flattened with their name as a prefix, because
 * a collection here is one level deep and inventing nesting to match would
 * change the data model for an import.
 *
 * Postman's scripts are *not* translated. They are written against the `pm.*`
 * API, which this app does not implement, so a mechanical copy would produce
 * code that throws on the first line. They are preserved as a comment with a
 * warning instead: a visible, honest migration note beats a silent breakage.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const MAX_REQUESTS = 300;

/** Postman stores a URL as a string or as a decomposed object. */
function readUrl(value: unknown): string {
  const direct = text(value);
  if (direct) return direct;
  if (!isRecord(value)) return '';

  const raw = text(value.raw);
  if (raw) return raw;

  const protocol = text(value.protocol) ?? 'https';
  const host = Array.isArray(value.host)
    ? value.host.filter((part) => typeof part === 'string').join('.')
    : (text(value.host) ?? '');
  const path = Array.isArray(value.path)
    ? value.path.filter((part) => typeof part === 'string').join('/')
    : (text(value.path) ?? '');
  const query = Array.isArray(value.query)
    ? value.query
        .filter(isRecord)
        .filter((entry) => entry.disabled !== true)
        .map((entry) => `${text(entry.key) ?? ''}=${text(entry.value) ?? ''}`)
        .join('&')
    : '';

  if (host === '') return '';
  const base = `${protocol}://${host}${path ? `/${path}` : ''}`;
  return query ? `${base}?${query}` : base;
}

function readHeaders(value: unknown): HeaderPair[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.header)
      ? value.header
      : [];

  return list
    .filter(isRecord)
    .map((entry) => ({
      name: (text(entry.key) ?? '').trim().toLowerCase(),
      value: text(entry.value) ?? '',
      enabled: entry.disabled !== true,
    }))
    .filter((header) => header.name !== '');
}

function readBody(
  value: unknown,
  warnings: string[],
  label: string,
): { body: string; contentType: string | null } {
  if (!isRecord(value)) return { body: '', contentType: null };
  const mode = text(value.mode);

  if (mode === 'raw') {
    const language = isRecord(value.options) && isRecord(value.options.raw)
      ? text(value.options.raw.language)
      : null;
    return {
      body: text(value.raw) ?? '',
      contentType:
        language === 'json'
          ? 'application/json'
          : language === 'xml'
            ? 'application/xml'
            : null,
    };
  }

  if (mode === 'urlencoded' && Array.isArray(value.urlencoded)) {
    const pairs = value.urlencoded
      .filter(isRecord)
      .filter((entry) => entry.disabled !== true)
      .map(
        (entry) =>
          `${encodeURIComponent(text(entry.key) ?? '')}=${encodeURIComponent(
            text(entry.value) ?? '',
          )}`,
      );
    return {
      body: pairs.join('&'),
      contentType: 'application/x-www-form-urlencoded',
    };
  }

  if (mode === 'formdata') {
    warnings.push(
      `${label} sends multipart form data, which this client does not build; the body was left empty.`,
    );
    return { body: '', contentType: null };
  }

  if (mode === 'file') {
    warnings.push(`${label} uploads a file, which cannot be imported.`);
    return { body: '', contentType: null };
  }

  return { body: text(value.raw) ?? '', contentType: null };
}

/** Bearer and basic become a header; anything else is reported. */
function readAuth(
  value: unknown,
  warnings: string[],
  label: string,
): HeaderPair | null {
  if (!isRecord(value)) return null;
  const type = text(value.type);
  if (!type || type === 'noauth') return null;

  const read = (key: string): string | null => {
    const entries = Array.isArray(value[type]) ? (value[type] as unknown[]) : [];
    const found = entries.filter(isRecord).find((entry) => text(entry.key) === key);
    return found ? (text(found.value) ?? null) : null;
  };

  if (type === 'bearer') {
    return {
      name: 'authorization',
      value: `Bearer ${read('token') ?? '{{token}}'}`,
      enabled: true,
    };
  }
  if (type === 'basic') {
    const username = read('username') ?? '{{username}}';
    const password = read('password') ?? '{{password}}';
    // Left readable rather than base64-encoded: the values are usually
    // {{variables}}, and encoding them would destroy the placeholder.
    warnings.push(
      `${label} uses basic auth; the header was added as credentials to encode before sending.`,
    );
    return {
      name: 'authorization',
      value: `Basic ${username}:${password}`,
      enabled: true,
    };
  }

  warnings.push(`${label} uses ${type} auth, which was not imported.`);
  return null;
}

function scriptComment(events: unknown, kind: string): string {
  if (!Array.isArray(events)) return '';
  const event = events
    .filter(isRecord)
    .find((entry) => text(entry.listen) === kind);
  if (!event || !isRecord(event.script)) return '';
  const lines = Array.isArray(event.script.exec)
    ? event.script.exec.filter((line): line is string => typeof line === 'string')
    : [];
  const source = lines.join('\n').trim();
  if (source === '') return '';

  return [
    `/* Imported from Postman. Not translated: this was written against the`,
    `   pm.* API, which this client does not provide. Rewrite it using vars`,
    `   and expect() if you need it.`,
    '',
    ...source.split('\n').map((line) => `   ${line}`),
    '*/',
    '',
  ].join('\n');
}

export function importPostman(input: unknown): ImportResult {
  const warnings: string[] = [];
  if (!isRecord(input)) {
    return { name: 'Imported', requests: [], warnings: ['That file is not a JSON object.'] };
  }

  const info = isRecord(input.info) ? input.info : {};
  const name = text(info.name) ?? 'Imported collection';
  const schema = text(info.schema) ?? '';
  if (schema && !schema.includes('v2')) {
    warnings.push(`Unexpected collection schema "${schema}"; importing anyway.`);
  }

  const requests: ImportedRequest[] = [];
  let stopped = false;

  const walk = (items: unknown, prefix: string[]): void => {
    if (!Array.isArray(items) || stopped) return;

    for (const itemInput of items) {
      if (stopped) return;
      if (!isRecord(itemInput)) continue;
      const itemName = text(itemInput.name) ?? 'Request';

      if (Array.isArray(itemInput.item)) {
        walk(itemInput.item, [...prefix, itemName]);
        continue;
      }

      const requestInput = itemInput.request;
      if (!isRecord(requestInput) && !text(requestInput)) continue;

      if (requests.length >= MAX_REQUESTS) {
        warnings.push(`Stopped at ${MAX_REQUESTS} requests; the rest were skipped.`);
        stopped = true;
        return;
      }

      const label = [...prefix, itemName].join(' / ');
      const request = isRecord(requestInput) ? requestInput : { url: requestInput };
      const method = (text(request.method) ?? 'GET').toUpperCase();
      const headers = readHeaders(request.header);
      const { body, contentType } = readBody(request.body, warnings, label);
      const auth = readAuth(request.auth ?? input.auth, warnings, label);

      if (auth && !headers.some((header) => header.name === 'authorization')) {
        headers.push(auth);
      }
      if (
        contentType &&
        !headers.some((header) => header.name === 'content-type')
      ) {
        headers.unshift({ name: 'content-type', value: contentType, enabled: true });
      }

      const url = readUrl(request.url);
      if (url === '') {
        warnings.push(`${label} has no usable URL and was skipped.`);
        continue;
      }

      requests.push({
        name: label,
        method,
        url,
        headers,
        body,
        ...(contentType === 'application/json' && body !== ''
          ? { bodyMode: 'json' as const }
          : {}),
        preRequestScript: scriptComment(itemInput.event, 'prerequest'),
        testScript: scriptComment(itemInput.event, 'test'),
      });
    }
  };

  walk(input.item, []);

  if (requests.length === 0) warnings.push('No requests were found in that collection.');
  const translated = requests.some(
    (request) => request.preRequestScript !== '' || request.testScript !== '',
  );
  if (translated) {
    warnings.push(
      'Postman scripts were imported as comments, not code: they use the pm.* API this client does not implement.',
    );
  }

  return { name, requests, warnings };
}

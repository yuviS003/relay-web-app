/*
 * Parses a curl command into a request.
 *
 * Pasting curl is how most API work actually starts: it is what browser devtools
 * copy, what docs print, and what a colleague sends you. Retyping it into a
 * form is the first friction a client can remove.
 *
 * This is a real shell-aware tokeniser rather than a regex. Splitting on spaces
 * breaks the moment a header value contains one, which is immediately, because
 * `-H 'content-type: application/json'` has a space in it.
 */

export type ParsedCurl = {
  method: string;
  url: string;
  headers: { name: string; value: string; enabled: boolean }[];
  body: string;
  /** Flags recognised but intentionally not applied, surfaced in the UI. */
  ignored: string[];
};

export type CurlParseResult =
  | { ok: true; request: ParsedCurl }
  | { ok: false; error: string };

/**
 * Splits a command line the way a POSIX shell would: single quotes are literal,
 * double quotes allow escapes, backslash-newline is a continuation.
 */
export function tokenise(input: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;

    if (quote === "'") {
      // Inside single quotes everything is literal, including backslashes.
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === '"') {
      if (char === '\\') {
        const next = input[index + 1];
        // Only these are special inside double quotes; anything else keeps
        // the backslash, which is what a shell does.
        if (next && ['"', '\\', '$', '`', '\n'].includes(next)) {
          if (next !== '\n') current += next;
          index += 1;
        } else {
          current += char;
        }
        continue;
      }
      if (char === '"') quote = null;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (char === '\\') {
      const next = input[index + 1];
      // Line continuation: curl commands are almost always pasted multi-line.
      if (next === '\n' || next === '\r') {
        index += next === '\r' && input[index + 2] === '\n' ? 2 : 1;
        continue;
      }
      if (next !== undefined) {
        current += next;
        index += 1;
        started = true;
        continue;
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (started || current !== '') {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  // An unterminated quote means the paste was truncated; better to say so than
  // to silently build a wrong request.
  if (quote !== null) return null;
  if (started || current !== '') tokens.push(current);
  return tokens;
}

/** Flags that take a value we do not model, so the value must be consumed. */
const VALUE_FLAGS_IGNORED = new Set([
  '--connect-timeout',
  '--max-time',
  '-m',
  '--retry',
  '--cacert',
  '--cert',
  '--key',
  '--proxy',
  '-x',
  '--resolve',
  '--interface',
  '--limit-rate',
  '-o',
  '--output',
  '-w',
  '--write-out',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '-b',
  '--cookie',
  '-u',
  '--user',
]);

/** Boolean flags that change nothing we model. */
const BOOLEAN_FLAGS_IGNORED = new Set([
  '-s',
  '--silent',
  '-S',
  '--show-error',
  '-v',
  '--verbose',
  '-k',
  '--insecure',
  '-i',
  '--include',
  '-f',
  '--fail',
  '-L',
  '--location',
  '--compressed',
  '-g',
  '--globoff',
  '--no-progress-meter',
]);

export function parseCurl(input: string): CurlParseResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, error: 'Paste a curl command' };

  const tokens = tokenise(trimmed);
  if (!tokens) {
    return { ok: false, error: 'Unbalanced quote: the command looks truncated' };
  }
  if (tokens[0] !== 'curl') {
    return { ok: false, error: 'The command must start with "curl"' };
  }

  const headers: ParsedCurl['headers'] = [];
  const ignored: string[] = [];
  const dataParts: string[] = [];
  let method: string | null = null;
  let url: string | null = null;
  let isForm = false;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const next = (): string | undefined => tokens[++index];

    if (token === '-X' || token === '--request') {
      method = (next() ?? 'GET').toUpperCase();
      continue;
    }

    if (token === '-H' || token === '--header') {
      const raw = next() ?? '';
      const separator = raw.indexOf(':');
      if (separator === -1) continue;
      const name = raw.slice(0, separator).trim();
      const value = raw.slice(separator + 1).trim();
      if (name !== '') headers.push({ name: name.toLowerCase(), value, enabled: true });
      continue;
    }

    if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-raw' ||
      token === '--data-binary' ||
      token === '--data-ascii'
    ) {
      dataParts.push(next() ?? '');
      continue;
    }

    if (token === '--data-urlencode') {
      dataParts.push(next() ?? '');
      isForm = true;
      continue;
    }

    if (token === '-F' || token === '--form') {
      // Multipart needs file handling the relay does not do; say so rather
      // than producing a request that silently sends the wrong thing.
      next();
      ignored.push(`${token} (multipart is not supported)`);
      continue;
    }

    if (token === '--url') {
      url = next() ?? null;
      continue;
    }

    if (token === '-G' || token === '--get') {
      method = 'GET';
      continue;
    }

    if (token === '-I' || token === '--head') {
      method = 'HEAD';
      continue;
    }

    if (VALUE_FLAGS_IGNORED.has(token)) {
      const value = next();
      ignored.push(`${token} ${value ?? ''}`.trim());
      continue;
    }

    if (BOOLEAN_FLAGS_IGNORED.has(token)) {
      ignored.push(token);
      continue;
    }

    // A long flag with an inline value, e.g. --header=...
    if (token.startsWith('--') && token.includes('=')) {
      const equals = token.indexOf('=');
      const name = token.slice(0, equals);
      const value = token.slice(equals + 1);
      if (name === '--header' || name === '--H') {
        const separator = value.indexOf(':');
        if (separator !== -1) {
          headers.push({
            name: value.slice(0, separator).trim().toLowerCase(),
            value: value.slice(separator + 1).trim(),
            enabled: true,
          });
        }
      } else if (name === '--data' || name === '--data-raw') {
        dataParts.push(value);
      } else if (name === '--url') {
        url = value;
      } else {
        ignored.push(token);
      }
      continue;
    }

    if (token.startsWith('-')) {
      ignored.push(token);
      continue;
    }

    // A bare token is the URL. curl allows it anywhere in the command.
    if (url === null) url = token;
  }

  if (url === null) return { ok: false, error: 'No URL found in the command' };
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  const body = dataParts.join(isForm ? '&' : '');

  // curl implies POST when data is present and no method was given.
  const resolvedMethod = method ?? (body !== '' ? 'POST' : 'GET');

  // And defaults the content type for -d, which is easy to forget and then
  // spend ten minutes debugging a 415.
  if (
    body !== '' &&
    !headers.some((header) => header.name === 'content-type')
  ) {
    headers.push({
      name: 'content-type',
      value: 'application/x-www-form-urlencoded',
      enabled: true,
    });
  }

  return {
    ok: true,
    request: {
      method: resolvedMethod,
      url,
      headers,
      body,
      ignored,
    },
  };
}

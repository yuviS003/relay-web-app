/*
 * Shapes for saved work, plus validators. Everything crossing an HTTP
 * boundary or coming out of the database is validated rather than trusted:
 * these documents drive request construction, so a malformed one becomes a
 * malformed outbound request.
 */

export type HeaderPair = {
  name: string;
  value: string;
  enabled: boolean;
};

export const CAPTURE_SOURCES = ['body', 'header', 'status'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export const AUTH_KINDS = ['none', 'basic', 'bearer', 'sigv4', 'oauth2'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/**
 * The saved auth configuration of a request.
 *
 * One flat record covering every kind, rather than a union per kind: it is
 * edited as a form where switching the kind should keep what was already
 * typed, and the server validates the fields the chosen kind needs.
 */
export type RequestAuthSpec = {
  kind: AuthKind;
  /** basic */
  username?: string;
  password?: string;
  /** bearer */
  token?: string;
  /** sigv4 */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  service?: string;
  /** oauth2 */
  grant?: 'client_credentials' | 'refresh_token';
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  scope?: string;
  audience?: string;
  clientAuth?: 'basic' | 'body';
};

/**
 * Takes a value out of this request's response and binds it to a variable the
 * next request in a run can use. Saved with the request, because the chain is
 * a property of the collection rather than of one session.
 */
export type Capture = {
  name: string;
  from: CaptureSource;
  /** A JSON path for a body, a header name for a header, unused for status. */
  path: string;
};

export const BODY_MODES = ['none', 'json', 'form', 'text', 'xml'] as const;
export type BodyMode = (typeof BODY_MODES)[number];

export type RequestSpec = {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: readonly HeaderPair[];
  body: string;
  /** Values to lift out of the response for later requests in a run. */
  captures?: readonly Capture[];
  /**
   * How to authenticate, applied server-side after substitution.
   *
   * Credentials are expected to be written as {{variables}}, so what a saved
   * collection contains is a reference and what is sent is resolved from the
   * environment — with secret values decrypted in the browser.
   */
  auth?: RequestAuthSpec;
  /** Active editor mode and per-mode drafts; optional for old saved requests. */
  bodyMode?: BodyMode;
  bodyDrafts?: Partial<Record<BodyMode, string>>;
  /** Runs in a sandbox before the request is sent. May rewrite variables. */
  preRequestScript: string;
  /** Runs in a sandbox after the response arrives. Declares assertions. */
  testScript: string;
};

export type Collection = {
  id: string;
  name: string;
  /**
   * Where this collection sits in the sidebar.
   *
   * Exists because the seeded workspace is a reading order — the starter
   * collection first, then one per feature — and sorting by name scattered it.
   * Absent for a collection someone made themselves, which sorts before the
   * positioned ones, by name.
   */
  order?: number;
  requests: readonly RequestSpec[];
  /**
   * Variables shared by every request in the collection. Lowest precedence:
   * the selected environment overrides them, and a script or a capture
   * overrides both. See lib/variables.ts.
   */
  variables?: readonly EnvVariable[];
};

export type EnvVariable = {
  name: string;
  /**
   * For a secret variable this is ciphertext produced in the browser, so the
   * stored copy is unreadable without the user's passphrase.
   */
  value: string;
  secret: boolean;
};

export type Environment = {
  id: string;
  name: string;
  /** PBKDF2 salt for this environment's secrets; null until one is set. */
  salt: string | null;
  variables: readonly EnvVariable[];
};

export const HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function fail(field: string, reason: string): never {
  throw new Error(`Invalid ${field}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max: number, min = 0): string {
  if (typeof value !== 'string') fail(field, 'must be a string');
  if (value.length < min || value.length > max) {
    fail(field, `must be ${min}-${max} characters`);
  }
  return value;
}

function id(value: unknown, field: string): string {
  const raw = text(value, field, 64, 1);
  if (!ID.test(raw)) fail(field, 'must be alphanumeric with - or _');
  return raw;
}

export function parseHeaderPair(value: unknown, field: string): HeaderPair {
  if (!isRecord(value)) fail(field, 'must be an object');
  const name = text(value.name, `${field}.name`, 128);

  // A header name with a colon or newline would let the caller inject an
  // extra header; reject at the edge rather than filtering later.
  if (name !== '' && !HEADER_NAME.test(name)) {
    fail(`${field}.name`, 'contains characters not allowed in a header name');
  }

  return {
    name,
    value: text(value.value, `${field}.value`, 8192),
    enabled: value.enabled !== false,
  };
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseCapture(value: unknown, field: string): Capture {
  if (!isRecord(value)) fail(field, 'must be an object');

  const name = text(value.name, `${field}.name`, 80, 1);
  // Must be a usable placeholder name, or the capture writes a variable no
  // request can reference.
  if (!VARIABLE_NAME.test(name)) {
    fail(`${field}.name`, 'must be a valid variable name');
  }

  const from = text(value.from, `${field}.from`, 16, 1);
  if (!(CAPTURE_SOURCES as readonly string[]).includes(from)) {
    fail(`${field}.from`, `must be one of ${CAPTURE_SOURCES.join(', ')}`);
  }

  const path = text(value.path ?? '', `${field}.path`, 300);
  if (from === 'body' && path.trim() === '') {
    fail(`${field}.path`, 'is required when capturing from the body');
  }
  if (from === 'header') {
    if (path.trim() === '') fail(`${field}.path`, 'must name a header');
    if (!HEADER_NAME.test(path.trim())) {
      fail(`${field}.path`, 'is not a valid header name');
    }
  }

  return { name, from: from as CaptureSource, path };
}

function parseVariable(value: unknown, field: string): EnvVariable {
  if (!isRecord(value)) fail(field, 'must be an object');
  const name = text(value.name, `${field}.name`, 80, 1);
  if (!VARIABLE_NAME.test(name)) {
    fail(`${field}.name`, 'must be a valid identifier');
  }
  return {
    name,
    value: text(value.value, `${field}.value`, 16384),
    secret: value.secret === true,
  };
}

export function parseRequestSpec(value: unknown, field: string): RequestSpec {
  if (!isRecord(value)) fail(field, 'must be an object');

  const method = text(value.method, `${field}.method`, 16, 1).toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    fail(`${field}.method`, `must be one of ${HTTP_METHODS.join(', ')}`);
  }

  if (!Array.isArray(value.headers) || value.headers.length > 50) {
    fail(`${field}.headers`, 'must be an array of at most 50 pairs');
  }

  const body = text(value.body, `${field}.body`, 256 * 1024);
  const rawMode = value.bodyMode;
  const bodyMode =
    typeof rawMode === 'string' && (BODY_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as BodyMode)
      : undefined;
  if (rawMode !== undefined && bodyMode === undefined) {
    fail(`${field}.bodyMode`, `must be one of ${BODY_MODES.join(', ')}`);
  }
  let bodyDrafts: Partial<Record<BodyMode, string>> | undefined;
  if (value.bodyDrafts !== undefined) {
    if (!isRecord(value.bodyDrafts)) fail(`${field}.bodyDrafts`, 'must be an object');
    bodyDrafts = {};
    for (const [key, draft] of Object.entries(value.bodyDrafts)) {
      if (!(BODY_MODES as readonly string[]).includes(key)) {
        fail(`${field}.bodyDrafts`, `contains unknown mode "${key}"`);
      }
      bodyDrafts[key as BodyMode] = text(
        draft,
        `${field}.bodyDrafts.${key}`,
        256 * 1024,
      );
    }
  }

  let auth: RequestAuthSpec | undefined;
  if (value.auth !== undefined) {
    if (!isRecord(value.auth)) fail(`${field}.auth`, 'must be an object');
    const kind = text(value.auth.kind ?? 'none', `${field}.auth.kind`, 16, 1);
    if (!(AUTH_KINDS as readonly string[]).includes(kind)) {
      fail(`${field}.auth.kind`, `must be one of ${AUTH_KINDS.join(', ')}`);
    }
    const parsed: RequestAuthSpec = { kind: kind as AuthKind };
    for (const key of [
      'username',
      'password',
      'token',
      'accessKeyId',
      'secretAccessKey',
      'sessionToken',
      'region',
      'service',
      'tokenUrl',
      'clientId',
      'clientSecret',
      'refreshToken',
      'scope',
      'audience',
    ] as const) {
      if (value.auth[key] === undefined) continue;
      parsed[key] = text(value.auth[key], `${field}.auth.${key}`, 4096);
    }
    if (value.auth.grant !== undefined) {
      parsed.grant =
        value.auth.grant === 'refresh_token' ? 'refresh_token' : 'client_credentials';
    }
    if (value.auth.clientAuth !== undefined) {
      parsed.clientAuth = value.auth.clientAuth === 'body' ? 'body' : 'basic';
    }
    auth = parsed;
  }

  let captures: Capture[] | undefined;
  if (value.captures !== undefined) {
    if (!Array.isArray(value.captures) || value.captures.length > 20) {
      fail(`${field}.captures`, 'must be an array of at most 20 captures');
    }
    captures = value.captures.map((entry, index) =>
      parseCapture(entry, `${field}.captures[${index}]`),
    );
  }

  return {
    id: id(value.id, `${field}.id`),
    name: text(value.name, `${field}.name`, 120, 1),
    method,
    url: text(value.url, `${field}.url`, 2048),
    headers: Object.freeze(
      value.headers.map((pair, index) =>
        parseHeaderPair(pair, `${field}.headers[${index}]`),
      ),
    ),
    body,
    // Optional so a collection saved before captures existed still loads.
    ...(captures ? { captures: Object.freeze(captures) } : {}),
    ...(auth && auth.kind !== 'none' ? { auth } : {}),
    ...(bodyMode ? { bodyMode } : {}),
    ...(bodyDrafts ? { bodyDrafts: Object.freeze(bodyDrafts) } : {}),
    preRequestScript: text(
      value.preRequestScript,
      `${field}.preRequestScript`,
      32 * 1024,
    ),
    // Optional so collections saved before tests existed still load.
    testScript:
      value.testScript === undefined
        ? ''
        : text(value.testScript, `${field}.testScript`, 32 * 1024),
  };
}

export function parseCollection(value: unknown): Collection {
  if (!isRecord(value)) fail('collection', 'must be an object');
  if (!Array.isArray(value.requests) || value.requests.length > 200) {
    fail('collection.requests', 'must be an array of at most 200 requests');
  }

  const requests = value.requests.map((request, index) =>
    parseRequestSpec(request, `collection.requests[${index}]`),
  );

  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.id)) {
      fail('collection.requests', `duplicate request id "${request.id}"`);
    }
    seen.add(request.id);
  }

  let variables: EnvVariable[] | undefined;
  if (value.variables !== undefined) {
    if (!Array.isArray(value.variables) || value.variables.length > 50) {
      fail('collection.variables', 'must be an array of at most 50 variables');
    }
    variables = value.variables.map((entry, index) =>
      parseVariable(entry, `collection.variables[${index}]`),
    );
    const names = new Set<string>();
    for (const variable of variables) {
      if (names.has(variable.name)) {
        fail('collection.variables', `duplicate variable "${variable.name}"`);
      }
      names.add(variable.name);
    }
  }

  let order: number | undefined;
  if (value.order !== undefined && value.order !== null) {
    if (
      typeof value.order !== 'number' ||
      !Number.isInteger(value.order) ||
      value.order < 0 ||
      value.order > 999
    ) {
      fail('collection.order', 'must be a whole number between 0 and 999');
    }
    order = value.order;
  }

  return {
    id: id(value.id, 'collection.id'),
    name: text(value.name, 'collection.name', 120, 1),
    ...(order !== undefined ? { order } : {}),
    requests: Object.freeze(requests),
    ...(variables ? { variables: Object.freeze(variables) } : {}),
  };
}

/**
 * Sidebar order: positioned collections in their position, anything
 * unpositioned first and alphabetical.
 *
 * Matches how MongoDB sorts `{ order: 1, name: 1 }` — a missing field sorts
 * before any number there — so the in-memory workspace and the stored one
 * present the same list rather than two different ones.
 */
export function compareCollections(a: Collection, b: Collection): number {
  const left = a.order ?? -1;
  const right = b.order ?? -1;
  return left === right ? a.name.localeCompare(b.name) : left - right;
}

export function parseEnvironment(value: unknown): Environment {
  if (!isRecord(value)) fail('environment', 'must be an object');
  if (!Array.isArray(value.variables) || value.variables.length > 100) {
    fail('environment.variables', 'must be an array of at most 100 variables');
  }

  const variables = value.variables.map((variable, index) =>
    parseVariable(variable, `environment.variables[${index}]`),
  );

  const seen = new Set<string>();
  for (const variable of variables) {
    if (seen.has(variable.name)) {
      fail('environment.variables', `duplicate variable "${variable.name}"`);
    }
    seen.add(variable.name);
  }

  return {
    id: id(value.id, 'environment.id'),
    name: text(value.name, 'environment.name', 120, 1),
    salt: value.salt === null ? null : text(value.salt, 'environment.salt', 256),
    variables: Object.freeze(variables),
  };
}

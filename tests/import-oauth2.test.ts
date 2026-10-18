import { beforeEach, describe, expect, it, vi } from 'vitest';

import { importOpenApi } from '../src/lib/import/openapi';
import { importPostman } from '../src/lib/import/postman';
import {
  acquireToken,
  authorizationHeader,
  buildTokenRequest,
  OAuth2Error,
  parseTokenResponse,
  __clearTokenCache,
  type OAuth2Config,
} from '../src/lib/signing/oauth2';

const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Billing API' },
  servers: [{ url: 'https://api.example.com/v1/' }],
  components: {
    schemas: {
      Invoice: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          total: { type: 'integer' },
          paid: { type: 'boolean' },
          lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } },
          status: { type: 'string', enum: ['draft', 'sent'] },
        },
      },
      Line: {
        type: 'object',
        properties: { sku: { type: 'string' }, self: { $ref: '#/components/schemas/Line' } },
      },
    },
  },
  paths: {
    '/invoices': {
      parameters: [
        { name: 'page', in: 'query', required: true, example: '1' },
        { name: 'x-tenant', in: 'header' },
      ],
      get: { operationId: 'listInvoices' },
      post: {
        summary: 'Create an invoice',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Invoice' } },
          },
        },
      },
    },
    '/invoices/{invoiceId}': {
      get: { operationId: 'getInvoice' },
      delete: {
        operationId: 'deleteInvoice',
        requestBody: { content: { 'text/csv': {} } },
      },
    },
  },
};

describe('importOpenApi', () => {
  const result = importOpenApi(OPENAPI);

  it('names the collection after the document', () => {
    expect(result.name).toBe('Billing API');
  });

  it('imports one request per operation', () => {
    expect(result.requests.map((request) => `${request.method} ${request.name}`)).toEqual([
      'GET listInvoices',
      'POST Create an invoice',
      'GET getInvoice',
      'DELETE deleteInvoice',
    ]);
  });

  it('prefixes the server URL and keeps required query parameters', () => {
    expect(result.requests[0]?.url).toBe('https://api.example.com/v1/invoices?page=1');
  });

  it('turns a path template into a variable', () => {
    expect(result.requests[2]?.url).toBe(
      'https://api.example.com/v1/invoices/{{invoiceId}}',
    );
  });

  it('carries header parameters across as a variable to fill', () => {
    expect(result.requests[0]?.headers).toEqual(
      expect.arrayContaining([
        { name: 'x-tenant', value: '{{x_tenant}}', enabled: true },
      ]),
    );
  });

  it('builds a body skeleton from the schema, stopping at a recursive ref', () => {
    const body = JSON.parse(result.requests[1]?.body ?? '{}');
    expect(body).toEqual({
      id: '00000000-0000-0000-0000-000000000000',
      total: 0,
      paid: false,
      // Line refers to itself; the second visit stops rather than unrolling.
      lines: [{ sku: '', self: null }],
      status: 'draft',
    });
    expect(result.requests[1]?.bodyMode).toBe('json');
  });

  it('warns rather than inventing a body for a format it cannot build', () => {
    expect(result.warnings.join(' ')).toContain('text/csv');
  });

  it('reports a document with no server and no paths instead of throwing', () => {
    const empty = importOpenApi({ openapi: '3.0.0', info: { title: 'Bare' }, paths: {} });
    expect(empty.requests).toEqual([]);
    expect(empty.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('No server URL'),
        expect.stringContaining('No operations'),
      ]),
    );
  });

  it('survives input that is not an OpenAPI document at all', () => {
    expect(importOpenApi('nope').requests).toEqual([]);
    expect(importOpenApi(null).warnings[0]).toContain('not a JSON object');
    expect(importOpenApi({ paths: { '/x': { get: 'not an object' } } }).requests).toEqual(
      [],
    );
  });
});

const POSTMAN = {
  info: { name: 'Team collection', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}' }] },
  item: [
    {
      name: 'Auth',
      item: [
        {
          name: 'Sign in',
          request: {
            method: 'POST',
            url: { raw: 'https://api.example.com/login', protocol: 'https' },
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"user":"{{email}}"}', options: { raw: { language: 'json' } } },
          },
          event: [
            {
              listen: 'test',
              script: { exec: ['pm.test("ok", function () {', '  pm.response.to.have.status(200);', '});'] },
            },
          ],
        },
      ],
    },
    {
      name: 'Search',
      request: {
        method: 'GET',
        url: {
          protocol: 'https',
          host: ['api', 'example', 'com'],
          path: ['v2', 'search'],
          query: [
            { key: 'q', value: 'cats' },
            { key: 'page', value: '2', disabled: true },
          ],
        },
        header: [{ key: 'X-Off', value: '1', disabled: true }],
      },
    },
    {
      name: 'Upload',
      request: { method: 'POST', url: 'https://api.example.com/upload', body: { mode: 'formdata' } },
    },
    { name: 'Broken', request: { method: 'GET', url: {} } },
  ],
};

describe('importPostman', () => {
  const result = importPostman(POSTMAN);

  it('flattens folders into prefixed names', () => {
    expect(result.requests.map((request) => request.name)).toEqual([
      'Auth / Sign in',
      'Search',
      'Upload',
    ]);
  });

  it('reads both URL shapes, dropping disabled query parameters', () => {
    expect(result.requests[0]?.url).toBe('https://api.example.com/login');
    expect(result.requests[1]?.url).toBe('https://api.example.com/v2/search?q=cats');
  });

  it('keeps header enablement rather than silently sending everything', () => {
    expect(result.requests[1]?.headers).toEqual([
      { name: 'x-off', value: '1', enabled: false },
      { name: 'authorization', value: 'Bearer {{access_token}}', enabled: true },
    ]);
  });

  it('applies the collection-level auth where a request has none', () => {
    expect(result.requests[0]?.headers).toEqual(
      expect.arrayContaining([
        { name: 'authorization', value: 'Bearer {{access_token}}', enabled: true },
      ]),
    );
  });

  it('imports a raw JSON body and marks the mode', () => {
    expect(result.requests[0]?.body).toBe('{"user":"{{email}}"}');
    expect(result.requests[0]?.bodyMode).toBe('json');
  });

  it('preserves a pm.* script as a comment and says it was not translated', () => {
    expect(result.requests[0]?.testScript).toContain('pm.response.to.have.status(200)');
    expect(result.requests[0]?.testScript).toContain('Not translated');
    expect(result.warnings.join(' ')).toContain('pm.* API');
  });

  it('skips what it cannot represent and names it', () => {
    expect(result.warnings.join(' ')).toContain('multipart form data');
    expect(result.warnings.join(' ')).toContain('Broken has no usable URL');
  });

  it('survives junk input', () => {
    expect(importPostman(42).requests).toEqual([]);
    expect(importPostman({ item: 'not an array' }).warnings[0]).toContain('No requests');
  });
});

describe('OAuth 2 token requests', () => {
  beforeEach(() => __clearTokenCache());

  const config: OAuth2Config = {
    grant: 'client_credentials',
    tokenUrl: 'https://auth.example.com/oauth/token',
    clientId: 'client',
    clientSecret: 'se:cret+value',
    scope: 'read write',
  };

  it('sends client credentials as a Basic header by default', () => {
    const request = buildTokenRequest(config);
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from('client:se%3Acret%2Bvalue').toString('base64')}`,
    );
    expect(request.body).toBe('grant_type=client_credentials&scope=read+write');
  });

  it('can put the credentials in the body instead', () => {
    const request = buildTokenRequest({ ...config, clientAuth: 'body' });
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).toContain('client_id=client');
    expect(request.body).toContain('client_secret=se%3Acret%2Bvalue');
  });

  it('builds a refresh grant and insists on the token', () => {
    const refresh = buildTokenRequest({
      ...config,
      grant: 'refresh_token',
      refreshToken: 'r1',
    });
    expect(refresh.body).toContain('grant_type=refresh_token');
    expect(refresh.body).toContain('refresh_token=r1');
    expect(() =>
      buildTokenRequest({ ...config, grant: 'refresh_token' }),
    ).toThrow(OAuth2Error);
  });

  it('refuses a token URL that is not http(s), or a missing client id', () => {
    expect(() => buildTokenRequest({ ...config, tokenUrl: 'ftp://x' })).toThrow(/token URL/);
    expect(() => buildTokenRequest({ ...config, clientId: '' })).toThrow(/client id/);
  });

  it('parses a token response and computes the expiry', () => {
    const token = parseTokenResponse(
      { access_token: 'abc', token_type: 'bearer', expires_in: 3600, scope: 'read' },
      1_000,
    );
    expect(token).toEqual({
      accessToken: 'abc',
      tokenType: 'bearer',
      expiresAt: 1_000 + 3_600_000,
      refreshToken: null,
      scope: 'read',
    });
    expect(authorizationHeader(token)).toBe('Bearer abc');
  });

  it('turns an OAuth error body into a readable failure', () => {
    expect(() =>
      parseTokenResponse({ error: 'invalid_client', error_description: 'bad secret' }),
    ).toThrow(/invalid_client: bad secret/);
    expect(() => parseTokenResponse({ token_type: 'bearer' })).toThrow(/no access_token/);
    expect(() => parseTokenResponse('not json')).toThrow(/did not return JSON/);
  });

  it('fetches once and reuses the token until it nearly expires', async () => {
    const send = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ access_token: 'first', expires_in: 60 }),
    }));
    let now = 1_000;

    const first = await acquireToken(config, send, () => now);
    const second = await acquireToken(config, send, () => now);
    expect(first.accessToken).toBe('first');
    expect(second.accessToken).toBe('first');
    expect(send).toHaveBeenCalledTimes(1);

    // Inside the 30s safety margin, so it refetches rather than signing with a
    // token that may expire in flight.
    now += 35_000;
    send.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ access_token: 'second', expires_in: 60 }),
    });
    const third = await acquireToken(config, send, () => now);
    expect(third.accessToken).toBe('second');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by everything that changes the token', async () => {
    const send = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ access_token: 'x', expires_in: 600 }),
    }));
    await acquireToken(config, send);
    await acquireToken({ ...config, scope: 'other' }, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports what the token endpoint said when it refuses', async () => {
    const send = vi.fn(async () => ({
      status: 401,
      body: JSON.stringify({ error: 'invalid_client' }),
    }));
    await expect(acquireToken(config, send)).rejects.toThrow(
      /responded 401: invalid_client/,
    );
  });
});

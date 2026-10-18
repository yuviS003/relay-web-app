import type { Collection, HeaderPair } from './types';

/*
 * The workspace a new visitor starts with.
 *
 * A request client is unusable until it holds a request, and every feature
 * here — chaining, auth signing, cookies, streaming, the viewers — is
 * invisible until something exercises it. So the seed is not a token "hello
 * world": it is one small collection per feature family, each pointing at a
 * public demo service that answers right now, with assertions that pass when
 * the feature works. Pressing ▶ on a collection is therefore also a check
 * that the relay, the guard, the sandbox and the signer are all alive.
 *
 * Rules the seed keeps to itself:
 *
 * - Credentials are written as {{variables}} and the values live in the
 *   collection's own variables, which is the pattern a real collection should
 *   copy. All of them are published demo credentials for public sandboxes
 *   (postman-echo, dummyjson, Duende's demo IdentityServer) or AWS's own
 *   documented example key pair. Nothing here is a real secret, and nothing
 *   here should be edited into one: an environment secret is encrypted in the
 *   browser, a collection variable is stored as written.
 * - Every target is a public HTTPS host, except the one request that exists to
 *   be refused.
 * - The hint for anything that needs a particular tab open is a comment at the
 *   top of the pre-request script, because that is the one place a note can
 *   live without inventing a field the store would then have to validate.
 *
 * Seeded once per owner. An existing workspace is never overwritten — see
 * `ensureSamples` in ./index.ts.
 */

const ACCEPT_JSON: readonly HeaderPair[] = Object.freeze([
  { name: 'accept', value: 'application/json', enabled: true },
]);

const SEND_JSON: readonly HeaderPair[] = Object.freeze([
  { name: 'content-type', value: 'application/json', enabled: true },
  { name: 'accept', value: 'application/json', enabled: true },
]);

/**
 * The relay, the guard, the sandbox and assertions — the four things the tool
 * is built on, in four requests.
 *
 * Kept first and kept stable: the empty-state copy and the tour both refer to
 * "Blocked: cloud metadata" by name.
 */
export const STARTER_COLLECTION: Collection = Object.freeze({
  id: 'starter',
  name: 'Starter',
  order: 0,
  requests: Object.freeze([
    {
      id: 'public-ip',
      name: 'Public IP',
      method: 'GET',
      url: 'https://api.ipify.org?format=json',
      headers: ACCEPT_JSON,
      body: '',
      preRequestScript: '',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('returns an ip', () => expect(response.json()).toHaveProperty('ip'));\n",
    },
    {
      id: 'blocked-metadata',
      name: 'Blocked: cloud metadata',
      method: 'GET',
      url: 'http://169.254.169.254/latest/meta-data/',
      headers: Object.freeze([]),
      body: '',
      preRequestScript: '',
      testScript: '',
    },
    {
      id: 'scripted-request',
      name: 'Scripted: timestamp',
      method: 'GET',
      url: 'https://postman-echo.com/get?ts={{stamp}}',
      headers: Object.freeze([]),
      body: '',
      preRequestScript:
        '// Runs sandboxed before the request is sent.\n' +
        '// Assign to vars to fill {{placeholders}}.\n' +
        'vars.stamp = String(Date.now());\n',
      testScript:
        "test('echoed the stamp', () => {\n  expect(response.json().args.ts).toBeTruthy();\n});\n",
    },
    {
      id: 'post-echo',
      name: 'POST echo',
      method: 'POST',
      url: 'https://postman-echo.com/post',
      headers: Object.freeze([
        { name: 'content-type', value: 'application/json', enabled: true },
      ]),
      body: '{\n  "hello": "world"\n}',
      preRequestScript: '',
      testScript:
        "test('echoes the body', () => {\n  expect(response.json().data.hello).toBe('world');\n});\n",
    },
  ]),
});

/**
 * Captures and the collection runner.
 *
 * Signs in to a public demo API, lifts the token and the user id out of the
 * response, and uses both in the two steps after it. Run the whole thing from
 * the ▶ beside the collection, or headless with `npm run collection`.
 */
const CHAINED_RUN: Collection = Object.freeze({
  id: 'samples-chain',
  name: 'Chained run',
  order: 1,
  variables: Object.freeze([
    { name: 'base_url', value: 'https://dummyjson.com', secret: false },
    { name: 'demo_user', value: 'emilys', secret: false },
    { name: 'demo_pass', value: 'emilyspass', secret: false },
  ]),
  requests: Object.freeze([
    {
      id: 'chain-sign-in',
      name: 'Sign in for a token',
      method: 'POST',
      url: '{{base_url}}/auth/login',
      headers: SEND_JSON,
      body: '{\n  "username": "{{demo_user}}",\n  "password": "{{demo_pass}}"\n}',
      bodyMode: 'json' as const,
      captures: Object.freeze([
        { name: 'auth_token', from: 'body' as const, path: '$.accessToken' },
        { name: 'user_id', from: 'body' as const, path: '$.id' },
      ]),
      preRequestScript:
        '// Press the ▶ beside "Chained run" in the sidebar to run all three\n' +
        '// steps in order. This one captures auth_token and user_id from the\n' +
        '// response (see the Tests tab) and the next two steps use them.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('returns a token', () => {\n  expect(response.json().accessToken).toBeTruthy();\n});\n",
    },
    {
      id: 'chain-whoami',
      name: 'Whoami with the captured token',
      method: 'GET',
      url: '{{base_url}}/auth/me',
      headers: ACCEPT_JSON,
      auth: Object.freeze({ kind: 'bearer' as const, token: '{{auth_token}}' }),
      body: '',
      preRequestScript:
        '// The Auth tab holds a bearer token written as a placeholder, which\n' +
        '// the previous step captured. The relay substitutes it and builds the\n' +
        '// Authorization header on the server, so no token is typed in here.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('the token identified someone', () => {\n  expect(response.json()).toHaveProperty('username');\n});\n",
    },
    {
      id: 'chain-user-by-id',
      name: 'Fetch the captured user id',
      method: 'GET',
      url: '{{base_url}}/users/{{user_id}}',
      headers: ACCEPT_JSON,
      body: '',
      preRequestScript:
        '// A captured value is an ordinary variable, usable anywhere — here in\n' +
        '// the path. Open the Vars tab: on its own this step reports user_id as\n' +
        '// unset, because only a run (or a script) can fill it.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('is a user record', () => {\n  expect(response.json()).toHaveProperty('username');\n});\n",
    },
  ]),
});

/**
 * The four auth helpers, each proved by the response.
 *
 * Every one is applied on the server, after substitution — so the echo
 * services here are showing the header the relay actually sent, which is the
 * only honest way to demonstrate a signature.
 */
const AUTH_HELPERS: Collection = Object.freeze({
  id: 'samples-auth',
  name: 'Auth helpers',
  order: 2,
  variables: Object.freeze([
    { name: 'echo_base', value: 'https://postman-echo.com', secret: false },
    { name: 'basic_user', value: 'postman', secret: false },
    { name: 'basic_pass', value: 'password', secret: false },
    { name: 'demo_token', value: 'relay-demo-token-9f2c', secret: false },
    // AWS's published example pair, used in their own signing documentation
    // and in this repo's SigV4 test vectors. Signs correctly, authorises
    // nothing.
    { name: 'aws_access_key_id', value: 'AKIAIOSFODNN7EXAMPLE', secret: false },
    {
      name: 'aws_secret_access_key',
      value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      secret: false,
    },
    { name: 'aws_region', value: 'us-east-1', secret: false },
    { name: 'aws_service', value: 'execute-api', secret: false },
    // Duende's public demo IdentityServer: the client id and secret below are
    // the ones it documents for anyone to use.
    {
      name: 'oauth_token_url',
      value: 'https://demo.duendesoftware.com/connect/token',
      secret: false,
    },
    {
      name: 'oauth_api_url',
      value: 'https://demo.duendesoftware.com/api/test',
      secret: false,
    },
    { name: 'oauth_client_id', value: 'm2m', secret: false },
    { name: 'oauth_client_secret', value: 'secret', secret: false },
    { name: 'oauth_scope', value: 'api', secret: false },
  ]),
  requests: Object.freeze([
    {
      id: 'auth-basic',
      name: 'Basic: username and password',
      method: 'GET',
      url: '{{echo_base}}/basic-auth',
      headers: ACCEPT_JSON,
      auth: Object.freeze({
        kind: 'basic' as const,
        username: '{{basic_user}}',
        password: '{{basic_pass}}',
      }),
      body: '',
      preRequestScript:
        '// This endpoint answers 401 without credentials. The Auth tab points\n' +
        '// at two collection variables, so the collection stores references\n' +
        '// and the relay resolves them at send time.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('the server accepted the credentials', () => {\n  expect(response.json().authenticated).toBe(true);\n});\n",
    },
    {
      id: 'auth-bearer',
      name: 'Bearer: token header',
      method: 'GET',
      url: '{{echo_base}}/get?demo=bearer',
      headers: ACCEPT_JSON,
      auth: Object.freeze({ kind: 'bearer' as const, token: '{{demo_token}}' }),
      body: '',
      preRequestScript:
        '// The echo service replies with the headers it received, so the\n' +
        '// Authorization line below is the one the relay really sent.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('sent a bearer header', () => {\n  expect(response.json().headers.authorization).toContain('Bearer ');\n});\n",
    },
    {
      id: 'auth-sigv4',
      name: 'AWS SigV4: signed POST',
      method: 'POST',
      url: '{{echo_base}}/post',
      headers: SEND_JSON,
      auth: Object.freeze({
        kind: 'sigv4' as const,
        accessKeyId: '{{aws_access_key_id}}',
        secretAccessKey: '{{aws_secret_access_key}}',
        region: '{{aws_region}}',
        service: '{{aws_service}}',
      }),
      body: '{\n  "note": "signed by the relay, not by the browser"\n}',
      bodyMode: 'json' as const,
      preRequestScript:
        '// Signing happens in the relay, after substitution, because the\n' +
        '// signature covers the exact URL and body that go out — and because a\n' +
        "// secret key has no business in a page script. AWS's documented\n" +
        '// example key pair is used, so this signs but authorises nothing.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('carried a v4 signature', () => {\n  expect(response.json().headers.authorization).toContain('AWS4-HMAC-SHA256');\n});\n" +
        "test('hashed the payload', () => {\n  expect(response.json().headers).toHaveProperty('x-amz-content-sha256');\n});\n",
    },
    {
      id: 'auth-oauth2',
      name: 'OAuth2: client credentials',
      method: 'GET',
      url: '{{oauth_api_url}}',
      headers: ACCEPT_JSON,
      auth: Object.freeze({
        kind: 'oauth2' as const,
        grant: 'client_credentials' as const,
        tokenUrl: '{{oauth_token_url}}',
        clientId: '{{oauth_client_id}}',
        clientSecret: '{{oauth_client_secret}}',
        scope: '{{oauth_scope}}',
        clientAuth: 'basic' as const,
      }),
      body: '',
      preRequestScript:
        '// Two requests in one send: the relay fetches a token from the token\n' +
        '// endpoint, caches it until it expires, then calls the API with it.\n' +
        '// The token request goes through the same guard as everything else.\n' +
        '// This one needs network access to a public demo IdentityServer.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('the API saw our client', () => {\n  expect(response.body).toContain('client_id');\n});\n",
    },
  ]),
});

/**
 * The cookie jar, which only exists in this tab's memory.
 *
 * The first request's cookie arrives on a redirect hop, which is the case that
 * makes a jar worth having: the relay collects Set-Cookie from every hop, not
 * just the last one.
 */
const COOKIES: Collection = Object.freeze({
  id: 'samples-cookies',
  name: 'Cookies',
  order: 3,
  variables: Object.freeze([
    { name: 'echo_base', value: 'https://postman-echo.com', secret: false },
  ]),
  requests: Object.freeze([
    {
      id: 'cookie-set',
      name: 'Set a cookie on a redirect',
      method: 'GET',
      url: '{{echo_base}}/cookies/set?relay_demo=hello',
      headers: ACCEPT_JSON,
      body: '',
      preRequestScript:
        '// Send this, then open the Cookies tab: relay_demo is in the jar. The\n' +
        '// Set-Cookie arrives on the 302, not on the final 200, so a relay that\n' +
        '// only read the last hop would lose it.\n' +
        '// The jar is in memory for this tab only — cookies are credentials.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('followed the redirect', () => {\n  expect(response.json()).toHaveProperty('cookies');\n});\n",
    },
    {
      id: 'cookie-read',
      name: 'Send the jar back',
      method: 'GET',
      url: '{{echo_base}}/cookies',
      headers: ACCEPT_JSON,
      body: '',
      preRequestScript:
        '// Send "Set a cookie on a redirect" first, then this: the jar adds a\n' +
        '// Cookie header for matching hosts and the value comes back. A run\n' +
        '// from the ▶ button does not use the jar, so there it stays empty.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('the server reported its cookies', () => {\n  expect(response.json()).toHaveProperty('cookies');\n});\n",
    },
  ]),
});

/**
 * The response side: the three body viewers, plus the history that makes two
 * responses comparable.
 */
const VIEWERS: Collection = Object.freeze({
  id: 'samples-viewers',
  name: 'Viewers and history',
  order: 4,
  requests: Object.freeze([
    {
      id: 'view-json-tree',
      name: 'Nested JSON for the tree',
      method: 'GET',
      url: 'https://jsonplaceholder.typicode.com/users',
      headers: ACCEPT_JSON,
      body: '',
      preRequestScript:
        '// Response → Body → Tree. Expand a row, or filter by path:\n' +
        '//   $[0].address.geo.lat        one value\n' +
        '//   $..email                    every email at any depth\n' +
        '// The same path syntax works for a capture in the Tests tab.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('returned a list', () => {\n  expect(response.json().length).toBeGreaterThan(0);\n});\n",
    },
    {
      id: 'view-html-preview',
      name: 'HTML for the sandboxed preview',
      method: 'GET',
      url: 'https://example.com',
      headers: Object.freeze([
        { name: 'accept', value: 'text/html', enabled: true },
      ]),
      body: '',
      preRequestScript:
        '// Response → Body → Preview renders this in a sandboxed iframe: no\n' +
        '// scripts, no network, nothing that could act on your session.\n' +
        '// The SEO and Extract tabs grade and mine the same HTML, in-browser.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('is html', () => {\n  expect(response.header('content-type')).toContain('html');\n});\n",
    },
    {
      id: 'view-hex',
      name: 'Binary for the hex view',
      method: 'GET',
      url: 'https://www.google.com/favicon.ico',
      headers: Object.freeze([{ name: 'accept', value: '*/*', enabled: true }]),
      body: '',
      preRequestScript:
        '// Response → Body → Hex, offset by offset. The relay hands the browser\n' +
        '// a UTF-8 decoded body, so a byte that is not valid UTF-8 is shown\n' +
        '// approximated; the byte count on the status line is the true size.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('is an image', () => {\n  expect(response.header('content-type')).toContain('image');\n});\n",
    },
    {
      id: 'view-diff',
      name: 'Changing payload to diff',
      method: 'GET',
      url: 'https://dummyjson.com/quotes/random',
      headers: ACCEPT_JSON,
      body: '',
      preRequestScript:
        '// Send twice, then Response → History and compare the two entries:\n' +
        '// the diff reports only the fields that moved. History is kept in this\n' +
        '// browser (IndexedDB), capped, and never uploaded.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('returned a quote', () => {\n  expect(response.json()).toHaveProperty('quote');\n});\n",
    },
  ]),
});

/**
 * The two request shapes that are not a plain round trip: a GraphQL document,
 * and a response that never ends on its own.
 */
const GRAPHQL_AND_STREAMS: Collection = Object.freeze({
  id: 'samples-graphql',
  name: 'GraphQL and streaming',
  order: 5,
  variables: Object.freeze([
    {
      name: 'graphql_url',
      value: 'https://countries.trevorblades.com/graphql',
      secret: false,
    },
  ]),
  requests: Object.freeze([
    {
      id: 'gql-country',
      name: 'GraphQL query with variables',
      method: 'POST',
      url: '{{graphql_url}}',
      headers: SEND_JSON,
      body:
        '{\n' +
        '  "query": "query Country($code: ID!) {\\n  country(code: $code) {\\n    name\\n    capital\\n    currency\\n  }\\n}\\n",\n' +
        '  "variables": {\n    "code": "IN"\n  },\n' +
        '  "operationName": "Country"\n' +
        '}',
      bodyMode: 'json' as const,
      preRequestScript:
        '// Open the GraphQL tab: the document, the variables and the operation\n' +
        '// name are edited there and written straight into this body, so\n' +
        '// nothing is stored twice. "Introspect schema" lists the fields the\n' +
        '// endpoint actually has and can draft an operation for one.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('resolved the query', () => {\n  expect(response.json().data.country.name).toBe('India');\n});\n" +
        '// A failed GraphQL query is still HTTP 200 with an errors array, which\n' +
        '// is why this assertion exists and why the response panel calls it out.\n' +
        "test('no graphql errors', () => {\n  expect(response.json().errors).toBeFalsy();\n});\n",
    },
    {
      id: 'stream-sse',
      name: 'Server-sent events',
      method: 'GET',
      url: 'https://postman-echo.com/server-events/5',
      headers: Object.freeze([
        { name: 'accept', value: 'text/event-stream', enabled: true },
      ]),
      body: '',
      preRequestScript:
        '// Open the Stream tab and press Start streaming: events are appended\n' +
        '// as they arrive, over a longer budget than a normal send, with the\n' +
        '// same guard, pinned address and byte cap.\n' +
        '// Send works too — it buffers until this stream closes, after five\n' +
        '// events, which is exactly what streaming avoids.\n',
      testScript:
        "test('responds 200', () => expect(response.status).toBe(200));\n" +
        "test('is an event stream', () => {\n  expect(response.header('content-type')).toContain('event-stream');\n});\n",
    },
  ]),
});

/**
 * Everything a fresh workspace is seeded with, in sidebar order.
 *
 * Also what a guest browses: the same list, served read-only, so signing in is
 * only needed to keep changes rather than to try anything.
 */
export const SAMPLE_COLLECTIONS: readonly Collection[] = Object.freeze([
  STARTER_COLLECTION,
  CHAINED_RUN,
  AUTH_HELPERS,
  COOKIES,
  VIEWERS,
  GRAPHQL_AND_STREAMS,
]);

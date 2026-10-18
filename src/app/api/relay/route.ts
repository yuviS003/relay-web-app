import { currentUser } from '@/lib/auth';
import { relay, type RelayRequest } from '@/lib/proxy/relay';
import { substitute } from '@/lib/placeholders';
import { applyAuth, AuthError, parseRequestAuth } from '@/lib/signing/apply';
import { isExecutableScript, runPreRequestScript } from '@/lib/scripting/sandbox';
import { runAssertions } from '@/lib/scripting/assertions';
import { resolveClientIdentity } from '@/lib/net/client-ip';
import { consumeQuota, GUEST_RELAY_POLICY, RELAY_POLICY } from '@/lib/quota';

/*
 * The relay endpoint.
 *
 * Node runtime, not edge: the guard needs DNS resolution and the relay needs
 * to pin a socket to a resolved address. Neither is possible in the edge
 * runtime, and `fetch` cannot pin a connection at all.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 256 * 1024;

type RelayBody = {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  script?: unknown;
  tests?: unknown;
  variables?: unknown;
  auth?: unknown;
  /** The Cookie header the caller's jar decided applies to this URL. */
  cookie?: unknown;
};

/*
 * Credentials are usually written as {{variables}}, so the auth block is
 * substituted like everything else before it is used. One level deep is
 * enough: the block is flat by construction.
 */
function substituteAuth(
  input: unknown,
  variables: Record<string, string>,
): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = typeof value === 'string' ? substitute(value, variables) : value;
  }
  return out;
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser(request.headers.get('cookie'));

  /*
   * Guests may traverse the relay but cannot save workspace data. The relay
   * stays SSRF-guarded and bounded by time, size and redirect limits for both.
   *
   * A signed-in caller is keyed by account id. A guest is keyed by the address
   * resolved in lib/net/client-ip.ts, which trusts a forwarded header only when
   * the operator has declared trusted proxies; otherwise every unidentified
   * guest shares one bucket. That is intentionally strict: a per-request
   * identity taken from a client-supplied header would let a caller reset its
   * own allowance at will.
   */
  const identity = user ? null : resolveClientIdentity(request.headers);
  const principal = user ? `user:${user.id}` : `guest:${identity?.key}`;
  const policy = user ? RELAY_POLICY : GUEST_RELAY_POLICY;

  /*
   * Quota first, before any work is done and before the pre-request script
   * runs. Uses the shared store when one is configured, so the limit holds
   * across serverless instances instead of resetting with each cold start.
   */
  const quota = await consumeQuota(`relay:${principal}`, policy);
  if (!quota.allowed) {
    return Response.json(
      { error: 'Rate limit exceeded', retryAfterMs: quota.retryAfterMs },
      {
        status: 429,
        headers: { 'retry-after': String(Math.ceil(quota.retryAfterMs / 1000)) },
      },
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json(
      { error: `Request body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }

  let parsed: RelayBody;
  try {
    parsed = JSON.parse(raw) as RelayBody;
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  if (typeof parsed.url !== 'string' || parsed.url === '') {
    return Response.json({ error: 'url is required' }, { status: 400 });
  }
  if (typeof parsed.method !== 'string' || parsed.method === '') {
    return Response.json({ error: 'method is required' }, { status: 400 });
  }

  const headersInput =
    typeof parsed.headers === 'object' && parsed.headers !== null
      ? (parsed.headers as Record<string, unknown>)
      : {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(headersInput)) {
    if (typeof value === 'string') headers[name] = value;
  }

  let variables: Record<string, string> = {};
  if (typeof parsed.variables === 'object' && parsed.variables !== null) {
    for (const [name, value] of Object.entries(
      parsed.variables as Record<string, unknown>,
    )) {
      if (typeof value === 'string') variables[name] = value;
    }
  }

  // The script runs before substitution so it can supply or rewrite values,
  // and inside a sandbox with no host access. See lib/scripting/sandbox.ts.
  let logs: readonly string[] = [];
  /*
   * What the script changed, echoed back so a collection run can carry it into
   * the next request — the same role a capture plays, for a value that was
   * computed rather than read off a response. Only the differences: echoing
   * the whole map would hand back every variable the caller just sent,
   * including decrypted secrets, for no gain.
   */
  const scriptVariables: Record<string, string> = {};
  /*
   * A script that is only comments is skipped: spinning up the sandbox is the
   * most expensive part of a request, and the saved samples carry explanatory
   * comments in this field.
   */
  if (typeof parsed.script === 'string' && isExecutableScript(parsed.script)) {
    const before = variables;
    const scripted = await runPreRequestScript(parsed.script, variables);
    if (!scripted.ok) {
      return Response.json(
        { error: `Pre-request script failed: ${scripted.error}` },
        { status: 422 },
      );
    }
    variables = scripted.variables;
    logs = scripted.logs;
    for (const [name, value] of Object.entries(variables)) {
      if (before[name] !== value) scriptVariables[name] = value;
    }
  }

  const substitutedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    substitutedHeaders[name] = substitute(value, variables);
  }

  /*
   * The caller's cookie jar decides what applies to this URL — domain, path
   * and Secure are enforced there, in lib/cookies.ts — and sends the result as
   * one header. An explicit Cookie header on the request wins, because that is
   * the user typing a specific value.
   */
  if (
    typeof parsed.cookie === 'string' &&
    parsed.cookie.trim() !== '' &&
    !Object.keys(substitutedHeaders).some((name) => name.toLowerCase() === 'cookie')
  ) {
    substitutedHeaders.cookie = substitute(parsed.cookie, variables);
  }

  const relayRequest: RelayRequest = {
    url: substitute(parsed.url, variables),
    method: parsed.method,
    headers: substitutedHeaders,
    body:
      typeof parsed.body === 'string' && parsed.body !== ''
        ? substitute(parsed.body, variables)
        : undefined,
  };

  /*
   * Off by default. Set PROXY_ALLOW_PRIVATE=true only for local development
   * against your own services; on a public deployment it turns the relay into
   * a window onto the host's private network.
   */
  const allowPrivate = process.env.PROXY_ALLOW_PRIVATE === 'true';

  /*
   * Auth is applied last, on the request as it will actually be sent. SigV4
   * signs the substituted URL and body, so signing any earlier would produce a
   * signature for a request that no longer exists.
   */
  try {
    const auth = parseRequestAuth(substituteAuth(parsed.auth, variables));
    const applied = await applyAuth(
      auth,
      {
        method: relayRequest.method,
        url: relayRequest.url,
        headers: relayRequest.headers,
        body: relayRequest.body ?? '',
      },
      // The token endpoint is a URL from a saved request, so it goes through
      // the same guard as everything else rather than a private fetch path.
      async (tokenRequest) => {
        const result = await relay(
          {
            url: tokenRequest.url,
            method: tokenRequest.method,
            headers: tokenRequest.headers,
            body: tokenRequest.body,
          },
          { allowPrivate },
        );
        if (!result.ok) {
          throw new AuthError(`Token request refused: ${result.detail}`);
        }
        return { status: result.status, body: result.body };
      },
    );
    Object.assign(relayRequest.headers, applied);
  } catch (error) {
    return Response.json(
      {
        ok: false,
        reason: 'auth-failed',
        error: error instanceof Error ? error.message : 'Authentication failed',
        logs,
        scriptVariables,
      },
      { status: 422 },
    );
  }

  /*
   * What actually goes out, reported back.
   *
   * The browser only knows what it composed: a URL full of {{placeholders}},
   * headers before substitution, and no auth header at all, because signing
   * and token fetching happen here. Without this, "why did the server reject
   * it" could only be answered by guessing at the request. Returning it is not
   * a disclosure — every value either came from this caller in this request or
   * was fetched with credentials it supplied.
   */
  const sent = {
    method: relayRequest.method,
    url: relayRequest.url,
    headers: { ...relayRequest.headers },
    body: relayRequest.body ?? '',
  };

  const result = await relay(relayRequest, { allowPrivate });

  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        // Included on a refusal too: seeing the resolved target is how you
        // find the unresolved variable that aimed it somewhere unexpected.
        sent,
        reason: result.reason,
        // Lets the UI explain the specific refusal instead of assuming every
        // block was a private-address refusal.
        ...(result.cause ? { cause: result.cause } : {}),
        error: result.detail,
        durationMs: result.durationMs,
        hops: result.hops,
        logs,
        scriptVariables,
      },
      // A refusal is a successful decision by the proxy, not a server fault,
      // so the UI can render it as a result rather than a crash.
      { status: result.reason === 'blocked' ? 403 : 200 },
    );
  }

  /*
   * Assertions run against the response that actually arrived, in the same
   * isolated VM as the pre-request script. A failing assertion is not a
   * transport error, so it never changes the HTTP status of this endpoint.
   */
  let assertions = null;
  if (typeof parsed.tests === 'string' && isExecutableScript(parsed.tests)) {
    assertions = await runAssertions(parsed.tests, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: result.body,
      durationMs: result.durationMs,
    });
  }

  return Response.json({
    ok: true,
    assertions,
    sent,
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    // Intact, so the caller's jar can apply domain, path and Secure rules.
    setCookies: result.setCookies,
    body: result.body,
    bodyBytes: result.bodyBytes,
    durationMs: result.durationMs,
    hops: result.hops,
    logs,
    scriptVariables,
    quotaRemaining: quota.remaining,
  });
}

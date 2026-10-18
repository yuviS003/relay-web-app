import { currentUser } from '@/lib/auth';
import { resolveClientIdentity } from '@/lib/net/client-ip';
import { substitute } from '@/lib/placeholders';
import { relay, type RelayRequest } from '@/lib/proxy/relay';
import { consumeQuota, GUEST_RELAY_POLICY, RELAY_POLICY } from '@/lib/quota';

/*
 * Streaming relay, for server-sent events and other long responses.
 *
 * The ordinary relay buffers, because buffering is what lets it enforce a size
 * cap and hand back one JSON result. That is wrong for an endpoint that stays
 * open and emits events: the whole point is seeing them arrive. So this route
 * forwards chunks as they come.
 *
 * What it does not do is relax the protections. The same guard decides the
 * address, the same pinned socket connects to it, every redirect is still
 * re-validated, and the byte cap still applies — only the time budget is
 * longer, because a stream that is idle is not a stream that is broken, and
 * even that is bounded.
 *
 * Output is itself SSE, with three event types, so a half-finished stream is
 * distinguishable from a finished one:
 *   open   the upstream status and headers
 *   chunk  text as it arrived
 *   done   the outcome, byte count and duration
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STREAM_TIMEOUT_MS = 120_000;
const STREAM_MAX_BYTES = 2 * 1024 * 1024;

function frame(event: string, data: unknown): string {
  // Every newline in the payload would start a new SSE field, so the data is
  // JSON on one line.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser(request.headers.get('cookie'));
  const identity = user ? null : resolveClientIdentity(request.headers);
  const principal = user ? `user:${user.id}` : `guest:${identity?.key}`;

  /*
   * A stream occupies a connection for far longer than a normal request, so it
   * is metered on the same bucket as the relay rather than given its own: one
   * caller cannot hold several open while still having a full allowance of
   * ordinary requests.
   */
  const quota = await consumeQuota(
    `relay:${principal}`,
    user ? RELAY_POLICY : GUEST_RELAY_POLICY,
  );
  if (!quota.allowed) {
    return Response.json(
      { error: 'Rate limit exceeded', retryAfterMs: quota.retryAfterMs },
      {
        status: 429,
        headers: { 'retry-after': String(Math.ceil(quota.retryAfterMs / 1000)) },
      },
    );
  }

  let parsed: {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
    variables?: unknown;
  };
  try {
    parsed = (await request.json()) as typeof parsed;
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  if (typeof parsed.url !== 'string' || parsed.url === '') {
    return Response.json({ error: 'url is required' }, { status: 400 });
  }

  const variables: Record<string, string> = {};
  if (typeof parsed.variables === 'object' && parsed.variables !== null) {
    for (const [name, value] of Object.entries(
      parsed.variables as Record<string, unknown>,
    )) {
      if (typeof value === 'string') variables[name] = value;
    }
  }

  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (typeof parsed.headers === 'object' && parsed.headers !== null) {
    for (const [name, value] of Object.entries(
      parsed.headers as Record<string, unknown>,
    )) {
      if (typeof value === 'string') headers[name] = substitute(value, variables);
    }
  }

  const relayRequest: RelayRequest = {
    url: substitute(parsed.url, variables),
    method: typeof parsed.method === 'string' ? parsed.method : 'GET',
    headers,
    body:
      typeof parsed.body === 'string' && parsed.body !== ''
        ? substitute(parsed.body, variables)
        : undefined,
  };

  const allowPrivate = process.env.PROXY_ALLOW_PRIVATE === 'true';
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let bytes = 0;
      let opened = false;

      const push = (event: string, data: unknown): void => {
        try {
          controller.enqueue(encoder.encode(frame(event, data)));
        } catch {
          // The client went away; the relay's own caps end the upstream read.
        }
      };

      const result = await relay(relayRequest, { allowPrivate }, {
        timeoutMs: STREAM_TIMEOUT_MS,
        maxBytes: STREAM_MAX_BYTES,
        // Not retained: a stream's length is unbounded by nature, and nothing
        // here needs the whole thing in memory.
        keepBody: false,
        sink: (chunk) => {
          if (!opened) {
            opened = true;
            push('open', { startedAt });
          }
          bytes += chunk.length;
          push('chunk', { text: chunk.toString('utf8'), bytes });
        },
      });

      push('done', {
        ok: result.ok,
        status: result.ok ? result.status : null,
        statusText: result.ok ? result.statusText : '',
        headers: result.ok ? result.headers : {},
        reason: result.ok ? null : result.reason,
        error: result.ok ? null : result.detail,
        bytes,
        durationMs: Date.now() - startedAt,
        hops: result.hops,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      // Without this a reverse proxy may buffer the whole stream and defeat
      // the entire feature.
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}

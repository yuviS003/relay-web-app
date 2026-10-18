import type { AssertionResult, RelayAttempt } from './types';

/*
 * Translating a relay response into a step outcome.
 *
 * The relay reports assertions as { name, passed, error } and refusals as a
 * 403 with a reason, which is right for its own API but not the shape a run
 * report wants. Both callers — the browser panel and the command-line runner —
 * need the same translation, so it lives here rather than being written twice
 * and drifting.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mapAssertions(value: unknown): RelayAttempt['assertions'] {
  if (!isRecord(value)) return null;

  const raw = Array.isArray(value.results) ? value.results : [];

  /*
   * `ok: false` from the relay means the assertion *script* threw, not that an
   * expectation failed — a failing expectation still arrives as ok with a
   * result whose `passed` is false. So a script error is "no results and a
   * message", and the verdict below is derived from the results rather than
   * taken on trust.
   */
  if (raw.length === 0 && typeof value.error === 'string') {
    return { ok: false, results: [], error: value.error };
  }

  const results: AssertionResult[] = raw.filter(isRecord).map((entry) => {
    const detail = typeof entry.error === 'string' ? entry.error : undefined;
    return {
      name: typeof entry.name === 'string' ? entry.name : 'assertion',
      ok: entry.passed === true,
      ...(detail ? { detail } : {}),
    };
  });

  return {
    ok: results.every((result) => result.ok),
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

function mapHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') headers[name] = entry;
  }
  return headers;
}

function mapVariables(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const variables: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') variables[name] = entry;
  }
  return Object.keys(variables).length > 0 ? variables : undefined;
}

export function relayAttemptFromResponse(
  httpStatus: number,
  payload: unknown,
): RelayAttempt {
  const body = isRecord(payload) ? payload : {};
  const scriptVariables = mapVariables(body.scriptVariables);

  // 429 and the rest arrive as an error envelope with no relay result at all.
  if (httpStatus === 429) {
    return {
      ok: false,
      error:
        typeof body.error === 'string'
          ? body.error
          : 'Rate limited by the relay',
      ...(scriptVariables ? { scriptVariables } : {}),
    };
  }

  if (body.ok !== true) {
    const blocked = body.reason === 'blocked' || httpStatus === 403;
    const reason =
      typeof body.error === 'string'
        ? body.error
        : typeof body.reason === 'string'
          ? body.reason
          : `Relay responded ${httpStatus}`;
    return {
      ok: false,
      ...(blocked ? { blocked: true } : {}),
      error: blocked ? `blocked: ${reason}` : reason,
      ...(typeof body.durationMs === 'number' ? { durationMs: body.durationMs } : {}),
      ...(scriptVariables ? { scriptVariables } : {}),
    };
  }

  return {
    ok: true,
    status: typeof body.status === 'number' ? body.status : undefined,
    statusText: typeof body.statusText === 'string' ? body.statusText : '',
    headers: mapHeaders(body.headers),
    body: typeof body.body === 'string' ? body.body : '',
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : 0,
    assertions: mapAssertions(body.assertions),
    ...(scriptVariables ? { scriptVariables } : {}),
  };
}

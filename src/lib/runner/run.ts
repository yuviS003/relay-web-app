import { readJsonPathValue } from '../json-path';
import type {
  Capture,
  CaptureOutcome,
  RelayAttempt,
  RunSummary,
  RunnableRequest,
  StepOutcome,
  StepStatus,
  Transport,
} from './types';

/*
 * The collection runner.
 *
 * A request is rarely interesting alone: you sign in, take the token out of
 * the response, and use it for everything after. That chaining is the whole
 * feature, so captures are applied between steps and the variable map is
 * carried forward.
 *
 * Deliberately sequential. Running a collection in parallel would reorder the
 * sign-in that the rest depends on, and the relay is quota-limited per caller
 * anyway, so concurrency buys a 429 rather than speed.
 */

const VALUE_PREVIEW = 120;

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.trim().toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Reads the captures of one response.
 *
 * A capture that misses is reported as a failure rather than writing an empty
 * variable: a blank token produces a confusing 401 two steps later, while a
 * named failed capture points straight at the cause.
 */
export function applyCaptures(
  attempt: RelayAttempt,
  captures: readonly Capture[] = [],
): { outcomes: CaptureOutcome[]; values: Record<string, string> } {
  const outcomes: CaptureOutcome[] = [];
  const values: Record<string, string> = {};

  let parsedBody: unknown;
  let bodyParsed = false;
  let bodyError: string | null = null;

  for (const capture of captures) {
    const name = capture.name.trim();
    if (name === '') continue;
    const base = { name, from: capture.from, path: capture.path };

    if (capture.from === 'status') {
      if (attempt.status === undefined) {
        outcomes.push({ ...base, ok: false, detail: 'no response to read' });
        continue;
      }
      values[name] = String(attempt.status);
      outcomes.push({ ...base, ok: true, value: values[name] });
      continue;
    }

    if (capture.from === 'header') {
      const value = headerValue(attempt.headers, capture.path);
      if (value === undefined) {
        outcomes.push({
          ...base,
          ok: false,
          detail: `response has no ${capture.path || '(unnamed)'} header`,
        });
        continue;
      }
      values[name] = value;
      outcomes.push({ ...base, ok: true, value });
      continue;
    }

    if (!bodyParsed) {
      bodyParsed = true;
      try {
        parsedBody = JSON.parse(attempt.body ?? '');
      } catch {
        bodyError = 'response body is not JSON';
      }
    }
    if (bodyError) {
      outcomes.push({ ...base, ok: false, detail: bodyError });
      continue;
    }

    let value: string | null;
    try {
      value = readJsonPathValue(parsedBody, capture.path);
    } catch (error) {
      outcomes.push({
        ...base,
        ok: false,
        detail: error instanceof Error ? error.message : 'invalid path',
      });
      continue;
    }
    if (value === null) {
      outcomes.push({ ...base, ok: false, detail: 'path matched nothing' });
      continue;
    }
    values[name] = value;
    outcomes.push({
      ...base,
      ok: true,
      value:
        value.length > VALUE_PREVIEW ? `${value.slice(0, VALUE_PREVIEW)}…` : value,
    });
  }

  return { outcomes, values };
}

function enabledHeaders(
  request: RunnableRequest,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of request.headers) {
    if (!pair.enabled) continue;
    const name = pair.name.trim();
    if (name !== '') headers[name] = pair.value;
  }
  return headers;
}

export type RunOptions = {
  collection: string;
  requests: readonly RunnableRequest[];
  variables?: Record<string, string>;
  send: Transport;
  /** Stop after the first failing step instead of running the rest. */
  bail?: boolean;
  delayMs?: number;
  signal?: AbortSignal;
  onStep?: (outcome: StepOutcome, index: number, total: number) => void;
  onVariables?: (values: Record<string, string>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function runCollection(options: RunOptions): Promise<RunSummary> {
  const {
    collection,
    requests,
    send,
    bail = false,
    delayMs = 0,
    signal,
    onStep,
    onVariables,
    now = () => Date.now(),
    sleep = wait,
  } = options;

  const variables: Record<string, string> = { ...(options.variables ?? {}) };
  const steps: StepOutcome[] = [];
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  let stopped = false;

  for (const [index, request] of requests.entries()) {
    const aborted = signal?.aborted === true;
    if (stopped || aborted) {
      const outcome: StepOutcome = {
        id: request.id,
        name: request.name,
        method: request.method,
        url: request.url,
        status: aborted ? 'aborted' : 'skipped',
        httpStatus: null,
        statusText: '',
        durationMs: 0,
        assertions: { passed: 0, failed: 0, results: [] },
        captures: [],
        error: aborted ? 'Run stopped' : 'Skipped after an earlier failure',
      };
      steps.push(outcome);
      onStep?.(outcome, index, requests.length);
      continue;
    }

    if (index > 0 && delayMs > 0) await sleep(delayMs);

    const begin = now();
    let attempt: RelayAttempt;
    try {
      attempt = await send({
        url: request.url,
        method: request.method,
        headers: enabledHeaders(request),
        body: request.body,
        script: request.preRequestScript,
        tests: request.testScript,
        variables: { ...variables },
        // Credentials are usually {{variables}}, so this travels as a
        // reference and the relay resolves it against the map above — which
        // means a token captured one step earlier signs the next one.
        ...(request.auth && request.auth.kind !== 'none'
          ? { auth: request.auth }
          : {}),
      });
    } catch (error) {
      attempt = {
        ok: false,
        error: error instanceof Error ? error.message : 'Request failed',
      };
    }

    // A script's assignments outlive their own step, the same as a capture:
    // computing a signature once and reusing it is a normal pattern.
    if (attempt.scriptVariables) {
      for (const [name, value] of Object.entries(attempt.scriptVariables)) {
        if (typeof value === 'string') variables[name] = value;
      }
    }

    const { outcomes, values } = attempt.ok
      ? applyCaptures(attempt, request.captures)
      : { outcomes: [] as CaptureOutcome[], values: {} as Record<string, string> };
    Object.assign(variables, values);
    if (outcomes.length > 0 || attempt.scriptVariables) {
      onVariables?.({ ...variables });
    }

    const results = [...(attempt.assertions?.results ?? [])];
    const passed = results.filter((result) => result.ok).length;
    const failed = results.length - passed;
    const captureFailed = outcomes.some((outcome) => !outcome.ok);

    const status: StepStatus = attempt.blocked
      ? 'blocked'
      : !attempt.ok || failed > 0 || captureFailed || attempt.assertions?.error
        ? 'failed'
        : 'passed';

    const outcome: StepOutcome = {
      id: request.id,
      name: request.name,
      method: request.method,
      url: request.url,
      status,
      httpStatus: attempt.status ?? null,
      statusText: attempt.statusText ?? '',
      durationMs: attempt.durationMs ?? Math.max(0, now() - begin),
      assertions: { passed, failed, results },
      captures: outcomes,
      error:
        attempt.error ??
        attempt.assertions?.error ??
        (captureFailed ? 'A capture did not resolve' : null),
    };
    steps.push(outcome);
    onStep?.(outcome, index, requests.length);

    if (bail && status !== 'passed') stopped = true;
  }

  const count = (status: StepStatus): number =>
    steps.filter((step) => step.status === status).length;

  return {
    collection,
    startedAt,
    durationMs: Math.max(0, now() - startedAtMs),
    total: steps.length,
    passed: count('passed'),
    failed: count('failed'),
    blocked: count('blocked'),
    skipped: count('skipped') + count('aborted'),
    assertionsPassed: steps.reduce((sum, step) => sum + step.assertions.passed, 0),
    assertionsFailed: steps.reduce((sum, step) => sum + step.assertions.failed, 0),
    ok: steps.length > 0 && steps.every((step) => step.status === 'passed'),
    steps,
    variables,
  };
}

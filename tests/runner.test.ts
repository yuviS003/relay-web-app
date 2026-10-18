import { describe, expect, it, vi } from 'vitest';

import { toJUnitXml, toTextReport } from '../src/lib/runner/junit';
import { applyCaptures, runCollection } from '../src/lib/runner/run';
import { relayAttemptFromResponse } from '../src/lib/runner/transport';
import type {
  RelayAttempt,
  RelayPayload,
  RunnableRequest,
} from '../src/lib/runner/types';

function request(overrides: Partial<RunnableRequest> = {}): RunnableRequest {
  return {
    id: 'r1',
    name: 'Request one',
    method: 'GET',
    url: 'https://api.example/one',
    headers: [],
    body: '',
    preRequestScript: '',
    testScript: '',
    ...overrides,
  };
}

const ok = (overrides: Partial<RelayAttempt> = {}): RelayAttempt => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: '{}',
  durationMs: 5,
  ...overrides,
});

describe('applyCaptures', () => {
  const attempt = ok({
    status: 201,
    headers: { 'Content-Type': 'application/json', location: '/items/9' },
    body: JSON.stringify({ data: { token: 'tok_123', nested: { id: 4 } } }),
  });

  it('reads a value out of a JSON body by path', () => {
    const { values, outcomes } = applyCaptures(attempt, [
      { name: 'token', from: 'body', path: '$.data.token' },
    ]);
    expect(values.token).toBe('tok_123');
    expect(outcomes[0]).toMatchObject({ name: 'token', ok: true, value: 'tok_123' });
  });

  it('reads headers case-insensitively and the status as text', () => {
    const { values } = applyCaptures(attempt, [
      { name: 'created', from: 'header', path: 'LOCATION' },
      { name: 'code', from: 'status', path: '' },
    ]);
    expect(values).toEqual({ created: '/items/9', code: '201' });
  });

  it('reports a miss instead of binding an empty variable', () => {
    const { values, outcomes } = applyCaptures(attempt, [
      { name: 'missing', from: 'body', path: '$.data.absent' },
      { name: 'noHeader', from: 'header', path: 'x-trace' },
    ]);
    expect(values).toEqual({});
    expect(outcomes.map((outcome) => outcome.detail)).toEqual([
      'path matched nothing',
      'response has no x-trace header',
    ]);
  });

  it('explains a body that is not JSON, and an unparseable path', () => {
    const text = applyCaptures(ok({ body: '<html></html>' }), [
      { name: 'x', from: 'body', path: '$.a' },
    ]);
    expect(text.outcomes[0]).toMatchObject({
      ok: false,
      detail: 'response body is not JSON',
    });

    const bad = applyCaptures(attempt, [{ name: 'x', from: 'body', path: '$.a[' }]);
    expect(bad.outcomes[0]?.ok).toBe(false);
    expect(bad.outcomes[0]?.detail).toMatch(/Unclosed/);
  });
});

describe('runCollection', () => {
  it('carries a captured value into the next request', async () => {
    const seen: RelayPayload[] = [];
    const send = vi.fn(async (payload: RelayPayload) => {
      seen.push(payload);
      return seen.length === 1
        ? ok({ body: JSON.stringify({ token: 'tok_abc' }) })
        : ok();
    });

    const summary = await runCollection({
      collection: 'Chained',
      send,
      requests: [
        request({
          id: 'sign-in',
          name: 'Sign in',
          captures: [{ name: 'token', from: 'body', path: '$.token' }],
        }),
        request({
          id: 'use',
          name: 'Use the token',
          headers: [{ name: 'authorization', value: 'Bearer {{token}}', enabled: true }],
        }),
      ],
    });

    expect(summary.ok).toBe(true);
    // The runner passes variables to the relay, which substitutes them; the
    // header therefore travels as written and the value travels beside it.
    expect(seen[1]?.variables.token).toBe('tok_abc');
    expect(seen[1]?.headers.authorization).toBe('Bearer {{token}}');
    expect(summary.variables.token).toBe('tok_abc');
  });

  it('sends only enabled headers', async () => {
    const seen: RelayPayload[] = [];
    await runCollection({
      collection: 'Headers',
      send: async (payload) => {
        seen.push(payload);
        return ok();
      },
      requests: [
        request({
          headers: [
            { name: 'x-on', value: '1', enabled: true },
            { name: 'x-off', value: '2', enabled: false },
            { name: '   ', value: '3', enabled: true },
          ],
        }),
      ],
    });
    expect(seen[0]?.headers).toEqual({ 'x-on': '1' });
  });

  it('counts assertions and marks a step with a failing one as failed', async () => {
    const summary = await runCollection({
      collection: 'Assertions',
      send: async () =>
        ok({
          assertions: {
            ok: false,
            results: [
              { name: 'is 200', ok: true },
              { name: 'has id', ok: false, detail: 'expected id' },
            ],
          },
        }),
      requests: [request()],
    });

    expect(summary.steps[0]?.status).toBe('failed');
    expect(summary.assertionsPassed).toBe(1);
    expect(summary.assertionsFailed).toBe(1);
    expect(summary.ok).toBe(false);
  });

  it('treats a refusal as blocked rather than a transport error', async () => {
    const summary = await runCollection({
      collection: 'Blocked',
      send: async () => ({
        ok: false,
        blocked: true,
        error: 'blocked: link-local address',
      }),
      requests: [request()],
    });
    expect(summary.steps[0]?.status).toBe('blocked');
    expect(summary.blocked).toBe(1);
  });

  it('fails a step whose capture missed, even when the response was fine', async () => {
    const summary = await runCollection({
      collection: 'Capture miss',
      send: async () => ok({ body: '{}' }),
      requests: [
        request({ captures: [{ name: 'token', from: 'body', path: '$.token' }] }),
      ],
    });
    expect(summary.steps[0]?.status).toBe('failed');
    expect(summary.steps[0]?.error).toBe('A capture did not resolve');
  });

  it('skips the rest when bailing, and records why', async () => {
    const send = vi.fn(async () => ({ ok: false, error: 'network down' }));
    const summary = await runCollection({
      collection: 'Bail',
      send,
      bail: true,
      requests: [request({ id: 'a' }), request({ id: 'b' }), request({ id: 'c' })],
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(summary.steps.map((step) => step.status)).toEqual([
      'failed',
      'skipped',
      'skipped',
    ]);
    expect(summary.skipped).toBe(2);
    expect(summary.steps[1]?.error).toMatch(/after an earlier failure/);
  });

  it('keeps going past a failure by default', async () => {
    let call = 0;
    const summary = await runCollection({
      collection: 'Continue',
      send: async () => {
        call += 1;
        return call === 1 ? { ok: false, error: 'boom' } : ok();
      },
      requests: [request({ id: 'a' }), request({ id: 'b' })],
    });
    expect(summary.steps.map((step) => step.status)).toEqual(['failed', 'passed']);
  });

  it('stops on an abort signal and marks the remainder aborted', async () => {
    const controller = new AbortController();
    const summary = await runCollection({
      collection: 'Aborted',
      signal: controller.signal,
      send: async () => {
        controller.abort();
        return ok();
      },
      requests: [request({ id: 'a' }), request({ id: 'b' })],
    });
    expect(summary.steps[0]?.status).toBe('passed');
    expect(summary.steps[1]?.status).toBe('aborted');
    expect(summary.ok).toBe(false);
  });

  it('turns a thrown transport into a failed step rather than an exception', async () => {
    const summary = await runCollection({
      collection: 'Throwing',
      send: async () => {
        throw new Error('socket closed');
      },
      requests: [request()],
    });
    expect(summary.steps[0]).toMatchObject({ status: 'failed', error: 'socket closed' });
  });

  it('carries script-assigned variables forward too', async () => {
    const seen: RelayPayload[] = [];
    await runCollection({
      collection: 'Scripted',
      send: async (payload) => {
        seen.push(payload);
        return ok({ scriptVariables: { stamp: '1700000000' } });
      },
      requests: [request({ id: 'a' }), request({ id: 'b' })],
    });
    expect(seen[1]?.variables.stamp).toBe('1700000000');
  });

  it('waits between steps when asked', async () => {
    const sleep = vi.fn(async () => undefined);
    await runCollection({
      collection: 'Paced',
      send: async () => ok(),
      sleep,
      delayMs: 250,
      requests: [request({ id: 'a' }), request({ id: 'b' }), request({ id: 'c' })],
    });
    // Between steps, not before the first one.
    expect(sleep.mock.calls).toEqual([[250], [250]]);
  });

  it('reports progress as it goes', async () => {
    const seen: string[] = [];
    await runCollection({
      collection: 'Progress',
      send: async () => ok(),
      onStep: (outcome, index, total) => seen.push(`${index + 1}/${total} ${outcome.id}`),
      requests: [request({ id: 'a' }), request({ id: 'b' })],
    });
    expect(seen).toEqual(['1/2 a', '2/2 b']);
  });

  it('is not ok when there is nothing to run', async () => {
    const summary = await runCollection({
      collection: 'Empty',
      send: async () => ok(),
      requests: [],
    });
    expect(summary.ok).toBe(false);
    expect(summary.total).toBe(0);
  });
});

describe('reports', () => {
  const summary = {
    collection: 'Suite & "edge"',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1500,
    total: 3,
    passed: 1,
    failed: 1,
    blocked: 0,
    skipped: 1,
    assertionsPassed: 1,
    assertionsFailed: 1,
    ok: false,
    variables: {},
    steps: [
      {
        id: 'a',
        name: 'Signs in',
        method: 'POST',
        url: 'https://api.example/login',
        status: 'passed' as const,
        httpStatus: 200,
        statusText: 'OK',
        durationMs: 120,
        assertions: { passed: 1, failed: 0, results: [{ name: 'is 200', ok: true }] },
        captures: [],
        error: null,
      },
      {
        id: 'b',
        name: 'Reads <items>',
        method: 'GET',
        url: 'https://api.example/items',
        status: 'failed' as const,
        httpStatus: 500,
        statusText: 'Server Error',
        durationMs: 80,
        assertions: {
          passed: 0,
          failed: 1,
          results: [{ name: 'has items', ok: false, detail: 'expected 1 & got 0' }],
        },
        captures: [],
        error: null,
      },
      {
        id: 'c',
        name: 'Deletes',
        method: 'DELETE',
        url: 'https://api.example/items/1',
        status: 'skipped' as const,
        httpStatus: null,
        statusText: '',
        durationMs: 0,
        assertions: { passed: 0, failed: 0, results: [] },
        captures: [],
        error: 'Skipped after an earlier failure',
      },
    ],
  };

  it('writes JUnit a pipeline can read', () => {
    const xml = toJUnitXml(summary);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('tests="3" failures="1" skipped="1"');
    expect(xml).toContain('classname="POST Signs in" name="is 200"');
    expect(xml).toContain('<failure message="expected 1 &amp; got 0">');
    expect(xml).toContain('<skipped message="Skipped after an earlier failure"/>');
  });

  it('escapes markup and control characters out of attributes and text', () => {
    const xml = toJUnitXml({
      ...summary,
      collection: 'a & b <c>',
      steps: [
        {
          ...summary.steps[1]!,
          name: 'quote " and \u0007bell',
          assertions: {
            passed: 0,
            failed: 1,
            results: [{ name: '<nested>', ok: false, detail: 'a > b' }],
          },
        },
      ],
    });
    expect(xml).toContain('name="a &amp; b &lt;c&gt;"');
    expect(xml).toContain('classname="GET quote &quot; and bell"');
    expect(xml).toContain('name="&lt;nested&gt;"');
    expect(xml).not.toMatch(/[\u0000-\u0008]/);
  });

  it('counts a step without assertions as one case', () => {
    const xml = toJUnitXml({
      ...summary,
      steps: [{ ...summary.steps[2]!, status: 'blocked', error: 'refused' }],
    });
    expect(xml).toContain('tests="1" failures="1"');
    expect(xml).toContain('<failure message="refused">');
  });

  it('summarises for a terminal', () => {
    const text = toTextReport(summary);
    expect(text).toContain('Suite & "edge": 1/3 steps passed');
    expect(text).toContain('✓ POST Signs in → 200 in 120ms · 1/1 assertions');
    expect(text).toContain('assertions 1 passed, 1 failed · 1500ms total');
  });
});

describe('relayAttemptFromResponse', () => {
  it('maps a successful relay response, renaming the assertion fields', () => {
    const attempt = relayAttemptFromResponse(200, {
      ok: true,
      status: 201,
      statusText: 'Created',
      headers: { location: '/x', bad: 2 },
      body: '{"a":1}',
      durationMs: 42,
      // The relay's own shape: ok is about the script, not the expectations.
      assertions: {
        ok: true,
        passed: 1,
        failed: 1,
        results: [
          { name: 'is 201', passed: true, error: null },
          { name: 'has id', passed: false, error: 'expected id' },
        ],
      },
      scriptVariables: { stamp: '1', ignored: 5 },
    });

    expect(attempt).toMatchObject({
      ok: true,
      status: 201,
      statusText: 'Created',
      headers: { location: '/x' },
      durationMs: 42,
      scriptVariables: { stamp: '1' },
    });
    expect(attempt.assertions).toEqual({
      ok: false,
      passed: 1,
      failed: 1,
      results: [
        { name: 'is 201', ok: true },
        { name: 'has id', ok: false, detail: 'expected id' },
      ],
    });
  });

  it('reads a refusal as blocked, however the status arrives', () => {
    const byReason = relayAttemptFromResponse(200, {
      ok: false,
      reason: 'blocked',
      error: 'link-local address',
    });
    expect(byReason).toMatchObject({ ok: false, blocked: true });
    expect(byReason.error).toBe('blocked: link-local address');

    expect(relayAttemptFromResponse(403, { ok: false, error: 'refused' })).toMatchObject(
      { blocked: true },
    );
  });

  it('reports a throttled run rather than treating it as a response', () => {
    const attempt = relayAttemptFromResponse(429, { error: 'Rate limit exceeded' });
    expect(attempt).toEqual({ ok: false, error: 'Rate limit exceeded' });
  });

  it('survives a response that is not the shape it expects', () => {
    expect(relayAttemptFromResponse(500, null)).toMatchObject({
      ok: false,
      error: 'Relay responded 500',
    });
    expect(relayAttemptFromResponse(200, { ok: true }).assertions).toBeNull();
    expect(relayAttemptFromResponse(200, { ok: true, body: 5 }).body).toBe('');
  });

  it('keeps a failed assertion script as a step failure with its message', () => {
    const attempt = relayAttemptFromResponse(200, {
      ok: true,
      status: 200,
      assertions: { ok: false, error: 'ReferenceError: x is not defined' },
    });
    expect(attempt.assertions).toMatchObject({
      ok: false,
      error: 'ReferenceError: x is not defined',
    });
  });
});

describe('runCollection and request auth', () => {
  it('forwards an auth block so a run authenticates like a send does', async () => {
    const seen: RelayPayload[] = [];
    const summary = await runCollection({
      collection: 'Authenticated',
      send: async (payload) => {
        seen.push(payload);
        return seen.length === 1
          ? ok({ body: JSON.stringify({ accessToken: 'tok_run' }) })
          : ok();
      },
      requests: [
        request({
          id: 'sign-in',
          captures: [{ name: 'auth_token', from: 'body', path: '$.accessToken' }],
        }),
        request({
          id: 'authenticated',
          auth: { kind: 'bearer', token: '{{auth_token}}' },
        }),
        request({ id: 'anonymous' }),
        request({ id: 'explicitly-none', auth: { kind: 'none' } }),
      ],
    });

    expect(summary.ok).toBe(true);
    // Travels as a reference, beside the variable that resolves it: the relay
    // substitutes and signs, so a token captured one step earlier is usable.
    expect(seen[1]?.auth).toEqual({ kind: 'bearer', token: '{{auth_token}}' });
    expect(seen[1]?.variables.auth_token).toBe('tok_run');

    // Absent rather than present-and-empty, both for a request with no auth
    // and for one that switched back to none in the editor.
    expect(seen[2] && 'auth' in seen[2]).toBe(false);
    expect(seen[3] && 'auth' in seen[3]).toBe(false);
  });
});

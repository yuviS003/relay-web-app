import { describe, expect, it } from 'vitest';

import { generateAssertions } from '../src/lib/analysis/testgen';
import { runAssertions, type ResponseContext } from '../src/lib/scripting/assertions';

const jsonResponse: ResponseContext = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ id: 1, name: 'widget', tags: ['a', 'b'] }),
  durationMs: 120,
};

describe('test generation', () => {
  it('asserts status, timing and content-type', () => {
    const script = generateAssertions(jsonResponse);
    expect(script).toContain('expect(response.status).toBe(200)');
    expect(script).toContain('response.durationMs');
    expect(script).toContain("response.header('content-type')");
    expect(script).toContain('toContain("json")');
  });

  it('emits a property assertion per top-level JSON key, capped', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) wide[`k${i}`] = i;
    const script = generateAssertions({
      ...jsonResponse,
      body: JSON.stringify(wide),
    });
    const props = script.match(/toHaveProperty/g) ?? [];
    expect(props.length).toBe(8);
  });

  it('generates a suite that actually passes against its own response', async () => {
    const script = generateAssertions(jsonResponse);
    const run = await runAssertions(script, jsonResponse);
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.failed).toBe(0);
      expect(run.passed).toBeGreaterThan(3);
    }
  });

  it('safely embeds keys containing quotes', async () => {
    const tricky: ResponseContext = {
      ...jsonResponse,
      body: JSON.stringify({ 'a"b': 1, "c'd": 2 }),
    };
    const script = generateAssertions(tricky);
    // The suite must still parse and pass, proving the keys were escaped.
    const run = await runAssertions(script, tricky);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.failed).toBe(0);
  });

  it('handles a non-JSON response without inventing JSON tests', () => {
    const script = generateAssertions({
      status: 404,
      headers: { 'content-type': 'text/html' },
      body: '<html></html>',
      durationMs: 30,
    });
    expect(script).toContain('toBe(404)');
    expect(script).toContain('toContain("html")');
    expect(script).not.toContain('response.json()');
  });
});

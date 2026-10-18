import { beforeEach, describe, expect, it } from 'vitest';

import {
  runPreRequestScript,
  SCRIPT_TIMEOUT_MS,
  isExecutableScript,
} from '../src/lib/scripting/sandbox';
import { substitute } from '../src/lib/placeholders';
import { __resetQuota, takeToken } from '../src/lib/quota';

/*
 * The sandbox runs code the user wrote. If it can reach the host, one saved
 * request becomes remote code execution on the server, so these tests are the
 * boundary, not a formality.
 */
describe('pre-request sandbox', () => {
  it('exposes vars and returns what the script assigned', async () => {
    const result = await runPreRequestScript(
      'vars.token = "abc" + vars.suffix;',
      { suffix: '123' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.variables.token).toBe('abc123');
  });

  it('coerces non-string values, since the result goes into text', async () => {
    const result = await runPreRequestScript(
      'vars.n = 42; vars.b = true; vars.nothing = null;',
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.variables.n).toBe('42');
      expect(result.variables.b).toBe('true');
      expect(result.variables.nothing).toBe('');
    }
  });

  it('captures console output without a bridge to the host console', async () => {
    const result = await runPreRequestScript('console.log("hello", 1);', {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.logs).toContain('hello 1');
  });

  it('stops an infinite loop instead of pinning a CPU forever', async () => {
    const startedAt = Date.now();
    const result = await runPreRequestScript('while (true) {}', {});
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    // The interrupt handler is the only thing that makes this survivable.
    expect(elapsed).toBeLessThan(SCRIPT_TIMEOUT_MS + 4000);
  }, 20_000);

  it('has no access to the filesystem', async () => {
    const result = await runPreRequestScript(
      'vars.out = typeof require + "/" + typeof process;',
      {},
    );
    expect(result.ok).toBe(true);
    // Neither exists: QuickJS has no host bindings unless they are installed,
    // and this sandbox installs none.
    if (result.ok) expect(result.variables.out).toBe('undefined/undefined');
  });

  it('has no network access', async () => {
    const result = await runPreRequestScript(
      'vars.out = typeof fetch + "/" + typeof XMLHttpRequest;',
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.variables.out).toBe('undefined/undefined');
  });

  it('cannot see the host globals', async () => {
    const result = await runPreRequestScript(
      'vars.out = typeof globalThis.process + typeof globalThis.Buffer;',
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.variables.out).toBe('undefinedundefined');
  });

  it('reports a syntax error rather than throwing', async () => {
    const result = await runPreRequestScript('this is not javascript', {});
    expect(result.ok).toBe(false);
  });

  it('reports a thrown error rather than throwing', async () => {
    const result = await runPreRequestScript('throw new Error("nope");', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('nope');
  });

  it('refuses an oversized script before starting a VM', async () => {
    const result = await runPreRequestScript('a;'.repeat(40_000), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('exceeds');
  });

  it('passes variables through untouched when there is no script', async () => {
    const result = await runPreRequestScript('   ', { a: '1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.variables).toEqual({ a: '1' });
  });

  it('survives being run repeatedly without leaking', async () => {
    // Each call creates and disposes a WASM runtime; a missing dispose would
    // grow the heap until the process dies.
    for (let i = 0; i < 12; i += 1) {
      const result = await runPreRequestScript(`vars.i = ${i};`, {});
      expect(result.ok).toBe(true);
    }
  }, 30_000);
});

describe('substitute', () => {
  it('replaces placeholders and tolerates whitespace', () => {
    expect(substitute('a/{{x}}/{{ y }}', { x: '1', y: '2' })).toBe('a/1/2');
  });

  it('leaves an unknown placeholder as written rather than emptying it', () => {
    // Silently blanking it would produce a subtly wrong request that is far
    // harder to debug than an obviously unresolved one.
    expect(substitute('{{missing}}', {})).toBe('{{missing}}');
  });

  it('ignores malformed placeholders', () => {
    expect(substitute('{{ 1bad }}', { '1bad': 'x' })).toBe('{{ 1bad }}');
  });
});

describe('relay quota', () => {
  beforeEach(() => {
    __resetQuota();
  });

  it('allows a burst then refuses', () => {
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < 110; i += 1) {
      if (takeToken('ip-a', now).allowed) allowed += 1;
    }
    expect(allowed).toBe(100);
    expect(takeToken('ip-a', now).allowed).toBe(false);
  });

  it('reports when a retry will succeed', () => {
    const now = Date.now();
    for (let i = 0; i < 101; i += 1) takeToken('ip-b', now);
    const decision = takeToken('ip-b', now);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time rather than all at once', () => {
    const now = Date.now();
    for (let i = 0; i < 101; i += 1) takeToken('ip-c', now);
    expect(takeToken('ip-c', now).allowed).toBe(false);

    // One token refills per second, so one second buys exactly one request.
    expect(takeToken('ip-c', now + 1000).allowed).toBe(true);
    expect(takeToken('ip-c', now + 1000).allowed).toBe(false);
  });

  it('keeps callers independent', () => {
    const now = Date.now();
    for (let i = 0; i < 101; i += 1) takeToken('noisy', now);
    expect(takeToken('noisy', now).allowed).toBe(false);
    // A different caller must not inherit an exhausted bucket.
    expect(takeToken('quiet', now).allowed).toBe(true);
  });

  it('does not delay recovery when a rejected caller keeps retrying', () => {
    const now = Date.now();
    for (let i = 0; i < 101; i += 1) takeToken('hammer', now);
    for (let i = 0; i < 200; i += 1) takeToken('hammer', now);
    // Recovery timing is unchanged by the rejected attempts.
    expect(takeToken('hammer', now + 1000).allowed).toBe(true);
  });
});

describe('isExecutableScript', () => {
  /*
   * The sandbox is the most expensive part of a send, so a field holding only
   * a note must not pay for it. The seeded sample requests do exactly that:
   * their pre-request script explains what the request demonstrates.
   */
  it('says no to whitespace and to comments', () => {
    for (const script of [
      '',
      '   \n\t ',
      '// just a note\n',
      '// two\n// lines\n',
      '/* a block */',
      '/*\n * several lines\n */\n',
      '// mixed\n/* block */\n   \n',
    ]) {
      expect(isExecutableScript(script), JSON.stringify(script)).toBe(false);
    }
  });

  it('says yes to anything that would actually run', () => {
    for (const script of [
      'vars.x = 1;',
      '// note\nvars.x = 1;',
      '/* note */ vars.x = 1;',
      'vars.url = "https://example.com//path";',
    ]) {
      expect(isExecutableScript(script), script).toBe(true);
    }
  });

  it('errs towards running when a comment marker is inside a string', () => {
    // Being wrong in this direction costs a sandbox boot; being wrong the
    // other way would silently skip a script that does something.
    expect(isExecutableScript('vars.a = "/* not a comment */";')).toBe(true);
  });
});

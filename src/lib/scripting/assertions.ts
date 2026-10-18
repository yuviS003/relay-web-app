import { getQuickJS } from 'quickjs-emscripten';

/*
 * Post-response assertions.
 *
 * This is the half of an API client that most alternatives leave out: they
 * replace the request builder and stop, so you still need a separate tool to
 * assert anything about what came back.
 *
 * It reuses the same QuickJS WebAssembly isolate as the pre-request sandbox,
 * for the same reason: the script is user-supplied, so running it with `eval`
 * would hand a saved request full access to the server process. The VM has no
 * network, no filesystem, and no host bindings.
 *
 * The script sees a frozen `response` object and calls `test(name, fn)`. Both
 * the harness and the assertion helpers are defined inside the VM, so there is
 * no bridge across the boundary at all: a JSON string goes in, a JSON string
 * comes back.
 */

export const ASSERT_TIMEOUT_MS = 1_000;
export const ASSERT_MEMORY_BYTES = 8 * 1024 * 1024;
export const MAX_ASSERT_SCRIPT_LENGTH = 32 * 1024;
const MAX_BODY_FOR_ASSERTIONS = 512 * 1024;

export type AssertionOutcome = {
  name: string;
  passed: boolean;
  error: string | null;
};

export type AssertionRun =
  | {
      ok: true;
      results: readonly AssertionOutcome[];
      logs: readonly string[];
      passed: number;
      failed: number;
    }
  | { ok: false; error: string };

export type ResponseContext = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
};

export async function runAssertions(
  script: string,
  response: ResponseContext,
): Promise<AssertionRun> {
  if (script.trim() === '') {
    return { ok: true, results: [], logs: [], passed: 0, failed: 0 };
  }
  if (script.length > MAX_ASSERT_SCRIPT_LENGTH) {
    return { ok: false, error: `Script exceeds ${MAX_ASSERT_SCRIPT_LENGTH} characters` };
  }

  /*
   * A large body is truncated before entering the VM. Serialising megabytes
   * into the interpreter would blow the memory ceiling and report a confusing
   * out-of-memory error instead of a useful assertion failure.
   */
  const safeResponse: ResponseContext = {
    ...response,
    body:
      response.body.length > MAX_BODY_FOR_ASSERTIONS
        ? response.body.slice(0, MAX_BODY_FOR_ASSERTIONS)
        : response.body,
  };

  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  let context;

  try {
    runtime.setMemoryLimit(ASSERT_MEMORY_BYTES);
    const deadline = Date.now() + ASSERT_TIMEOUT_MS;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    context = runtime.newContext();

    const program = `
      (function () {
        var __results = [];
        var __logs = [];
        var console = {
          log: function () {
            __logs.push(Array.prototype.slice.call(arguments).map(String).join(' '));
          }
        };
        console.info = console.log; console.warn = console.log; console.error = console.log;

        var response = ${JSON.stringify(safeResponse)};

        // Parsed lazily and cached: most scripts want json(), but a non-JSON
        // body should not make the whole run fail before any test executes.
        var __json; var __jsonDone = false;
        response.json = function () {
          if (!__jsonDone) { __jsonDone = true; try { __json = JSON.parse(response.body); } catch (e) { __json = undefined; } }
          if (__json === undefined) throw new Error('Response body is not valid JSON');
          return __json;
        };
        response.header = function (name) {
          return response.headers[String(name).toLowerCase()];
        };

        function deepEqual(a, b) {
          if (a === b) return true;
          if (typeof a !== typeof b || a === null || b === null) return false;
          if (typeof a !== 'object') return false;
          var ka = Object.keys(a), kb = Object.keys(b);
          if (ka.length !== kb.length) return false;
          for (var i = 0; i < ka.length; i++) {
            if (!deepEqual(a[ka[i]], b[ka[i]])) return false;
          }
          return true;
        }

        function expect(actual) {
          return {
            toBe: function (want) {
              if (actual !== want) throw new Error('expected ' + JSON.stringify(want) + ' but got ' + JSON.stringify(actual));
            },
            toEqual: function (want) {
              if (!deepEqual(actual, want)) throw new Error('expected ' + JSON.stringify(want) + ' but got ' + JSON.stringify(actual));
            },
            toContain: function (want) {
              var ok = typeof actual === 'string' ? actual.indexOf(want) !== -1
                : Array.isArray(actual) ? actual.indexOf(want) !== -1 : false;
              if (!ok) throw new Error('expected ' + JSON.stringify(actual) + ' to contain ' + JSON.stringify(want));
            },
            toBeTruthy: function () { if (!actual) throw new Error('expected a truthy value, got ' + JSON.stringify(actual)); },
            toBeFalsy: function () { if (actual) throw new Error('expected a falsy value, got ' + JSON.stringify(actual)); },
            toBeLessThan: function (want) { if (!(actual < want)) throw new Error('expected ' + actual + ' < ' + want); },
            toBeGreaterThan: function (want) { if (!(actual > want)) throw new Error('expected ' + actual + ' > ' + want); },
            toHaveProperty: function (key) {
              if (!actual || !Object.prototype.hasOwnProperty.call(actual, key)) {
                throw new Error('expected an object with property ' + JSON.stringify(key));
              }
            }
          };
        }

        function test(name, fn) {
          try { fn(); __results.push({ name: String(name), passed: true, error: null }); }
          catch (e) {
            // One failing assertion must not stop the rest: the point of a
            // suite is seeing everything that is wrong in one run.
            __results.push({ name: String(name), passed: false, error: e && e.message ? String(e.message) : String(e) });
          }
        }
        var it = test;

        ${script}

        return JSON.stringify({ results: __results, logs: __logs });
      })()
    `;

    const evaluated = context.evalCode(program);

    if (evaluated.error) {
      const dumped = context.dump(evaluated.error) as unknown;
      evaluated.error.dispose();
      const message =
        typeof dumped === 'string'
          ? dumped
          : ((dumped as { message?: string })?.message ?? 'Assertion script failed');
      return { ok: false, error: message };
    }

    const raw = context.getString(evaluated.value);
    evaluated.value.dispose();

    const parsed = JSON.parse(raw) as {
      results: AssertionOutcome[];
      logs: string[];
    };

    return {
      ok: true,
      results: Object.freeze(parsed.results),
      logs: Object.freeze(parsed.logs.slice(0, 50)),
      passed: parsed.results.filter((result) => result.passed).length,
      failed: parsed.results.filter((result) => !result.passed).length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: /interrupt/i.test(message)
        ? `Assertions exceeded ${ASSERT_TIMEOUT_MS}ms and were stopped`
        : message,
    };
  } finally {
    // The WASM heap is not collected by the host; skipping dispose leaks for
    // the life of the process.
    context?.dispose();
    runtime.dispose();
  }
}

export const SAMPLE_ASSERTIONS = `test('responds 200', () => {
  expect(response.status).toBe(200);
});

test('arrives quickly', () => {
  expect(response.durationMs).toBeLessThan(2000);
});

test('returns JSON', () => {
  expect(response.header('content-type')).toContain('json');
});
`;

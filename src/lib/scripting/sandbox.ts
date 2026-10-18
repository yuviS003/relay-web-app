import { getQuickJS } from 'quickjs-emscripten';

/*
 * Runs a user's pre-request script.
 *
 * `eval` and `new Function` are not options: the script would run with full
 * access to the server process, so one saved request could read environment
 * variables, reach the database, or call internal services. QuickJS compiled
 * to WebAssembly gives a separate interpreter with no ambient capability at
 * all. The VM has no network, no filesystem, no timers, and no host bindings
 * unless they are deliberately installed, and this module installs none.
 *
 * The only channel is a JSON string in and a JSON string out. That keeps the
 * attack surface to the JSON parser rather than to the host object graph.
 *
 * Two resource limits, because an unbounded interpreter is still a denial of
 * service: an interrupt handler stops a script that runs too long (`while(1){}`
 * would otherwise pin a CPU forever) and a memory ceiling stops one that
 * allocates until the process dies.
 */

export const SCRIPT_TIMEOUT_MS = 1_000;
export const SCRIPT_MEMORY_BYTES = 8 * 1024 * 1024;
export const MAX_SCRIPT_LENGTH = 32 * 1024;

export type SandboxResult =
  | { ok: true; variables: Record<string, string>; logs: readonly string[] }
  | { ok: false; error: string };

/**
 * Executes `script` with `variables` exposed as a mutable `vars` object and
 * returns the resulting values. Anything the script assigns to `vars` is
 * coerced to a string, because the result is substituted into a URL, a header,
 * or a body, all of which are text.
 */
/**
 * Whether a script has anything to run, ignoring comments.
 *
 * Booting a WebAssembly JavaScript engine costs more than the rest of a
 * request put together, and a script that is only a comment — a note on a
 * saved request explaining what it demonstrates, say — has nothing to execute.
 * Checking first keeps those requests as fast as ones with no script at all.
 *
 * Deliberately conservative: a `//` or `/* *\/` inside a string literal makes
 * this answer "there is code here", which is the safe direction to be wrong in.
 */
export function isExecutableScript(script: string): boolean {
  const withoutComments = script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return withoutComments.trim() !== '';
}

export async function runPreRequestScript(
  script: string,
  variables: Record<string, string>,
): Promise<SandboxResult> {
  if (script.trim() === '') {
    return { ok: true, variables, logs: [] };
  }

  if (script.length > MAX_SCRIPT_LENGTH) {
    return {
      ok: false,
      error: `Script exceeds ${MAX_SCRIPT_LENGTH} characters`,
    };
  }

  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  let context;

  try {
    runtime.setMemoryLimit(SCRIPT_MEMORY_BYTES);

    // Checked periodically by the interpreter; returning true aborts. This is
    // what makes an infinite loop survivable.
    const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
    runtime.setInterruptHandler(() => Date.now() > deadline);

    context = runtime.newContext();

    /*
     * The script is wrapped so it never touches the host. It receives a plain
     * object parsed from JSON, and its result leaves as JSON text. `console`
     * is a local shim collecting strings rather than a bridge to the real one.
     */
    const program = `
      (function () {
        var __logs = [];
        var console = {
          log: function () {
            __logs.push(Array.prototype.slice.call(arguments).map(String).join(' '));
          }
        };
        console.info = console.log;
        console.warn = console.log;
        console.error = console.log;
        var vars = ${JSON.stringify(variables)};
        ${script}
        var out = {};
        for (var key in vars) {
          if (Object.prototype.hasOwnProperty.call(vars, key)) {
            var value = vars[key];
            out[key] = value === null || value === undefined ? '' : String(value);
          }
        }
        return JSON.stringify({ vars: out, logs: __logs });
      })()
    `;

    const evaluated = context.evalCode(program);

    if (evaluated.error) {
      const message = context.dump(evaluated.error) as unknown;
      evaluated.error.dispose();
      return {
        ok: false,
        error:
          typeof message === 'string'
            ? message
            : ((message as { message?: string })?.message ??
              'Script failed'),
      };
    }

    const raw = context.getString(evaluated.value);
    evaluated.value.dispose();

    const parsed = JSON.parse(raw) as {
      vars: Record<string, string>;
      logs: string[];
    };

    return {
      ok: true,
      variables: parsed.vars,
      logs: Object.freeze(parsed.logs.slice(0, 50)),
    };
  } catch (error) {
    // An interrupt or a memory breach surfaces as a thrown error here. Both
    // mean the script misbehaved, not that the server is broken.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: /interrupt/i.test(message)
        ? `Script exceeded ${SCRIPT_TIMEOUT_MS}ms and was stopped`
        : message,
    };
  } finally {
    // The WASM heap is not garbage collected by the host, so failing to
    // dispose leaks memory for the life of the process.
    context?.dispose();
    runtime.dispose();
  }
}

/*
 * Substitution lives in lib/placeholders.ts: the browser needs it, and this
 * module loads a WebAssembly engine that the browser must not.
 */

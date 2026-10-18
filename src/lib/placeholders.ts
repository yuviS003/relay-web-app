/*
 * {{placeholder}} handling, on its own.
 *
 * Separate from the script sandbox so the browser can reason about
 * placeholders — which ones a request mentions, whether they resolve — without
 * pulling a WebAssembly JavaScript engine into the bundle. One definition of
 * what a placeholder looks like, used by substitution and by the resolution
 * view, so the two cannot disagree about what counts as one.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Replaces {{name}} placeholders. An unknown name is left as written. */
export function substitute(
  input: string,
  variables: Record<string, string>,
): string {
  return input.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name)
      ? (variables[name] ?? '')
      : match,
  );
}

/** Every distinct placeholder name in `input`, in the order first seen. */
export function findPlaceholderNames(input: string): string[] {
  const names: string[] = [];
  for (const match of input.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

const ASSIGNMENT =
  /\bvars\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])\s*=(?!=)/g;

/**
 * Names a pre-request script assigns to `vars`.
 *
 * Only for explaining resolution: a value computed at send time has no
 * preview, but reporting it as unset would be misleading, since it is the
 * script's whole purpose. Read with a regex rather than by executing anything,
 * so inspecting a request never runs its code.
 */
export function findScriptAssignments(script: string): string[] {
  const names: string[] = [];
  for (const match of script.matchAll(ASSIGNMENT)) {
    const name = match[1] ?? match[2];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

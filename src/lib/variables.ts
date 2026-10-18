import { findPlaceholderNames } from '@/lib/placeholders';

/*
 * Where a {{variable}} came from.
 *
 * Three layers, lowest precedence first: a collection's own variables, then
 * the selected environment, then anything a pre-request script or a capture
 * from an earlier response assigned. Script values win because they are the
 * most specific statement of intent — a run that captures a fresh token should
 * not be overridden by a stale one saved in the environment.
 *
 * The resolution report exists because an unresolved placeholder is sent
 * literally, and "why is my API rejecting {{token}}" is otherwise answered by
 * guessing which of three layers was meant to define it.
 */

export const VARIABLE_SCOPES = ['collection', 'environment', 'script'] as const;
export type VariableScope = (typeof VARIABLE_SCOPES)[number];

export type VariableInput = {
  name: string;
  value: string;
  secret?: boolean;
};

export type VariableLayers = {
  collection?: readonly VariableInput[];
  environment?: readonly VariableInput[];
  script?: Readonly<Record<string, string>>;
};

export type ResolvedVariable = {
  name: string;
  value: string;
  scope: VariableScope;
  secret: boolean;
  /** Layers that also defined this name and lost. */
  shadowed: VariableScope[];
};

export type VariableResolution = {
  values: Record<string, string>;
  byName: Record<string, ResolvedVariable>;
  list: ResolvedVariable[];
};

export function resolveVariables(layers: VariableLayers): VariableResolution {
  const byName: Record<string, ResolvedVariable> = {};

  const apply = (
    scope: VariableScope,
    entries: readonly VariableInput[],
  ): void => {
    for (const entry of entries) {
      const name = entry.name.trim();
      if (name === '') continue;
      const previous = byName[name];
      byName[name] = {
        name,
        value: entry.value,
        scope,
        secret: entry.secret === true,
        shadowed: previous ? [...previous.shadowed, previous.scope] : [],
      };
    }
  };

  apply('collection', layers.collection ?? []);
  apply('environment', layers.environment ?? []);
  apply(
    'script',
    Object.entries(layers.script ?? {}).map(([name, value]) => ({ name, value })),
  );

  const list = Object.values(byName).sort((a, b) => a.name.localeCompare(b.name));
  const values: Record<string, string> = {};
  for (const entry of list) values[entry.name] = entry.value;

  return { values, byName, list };
}

export type PlaceholderUse = 'url' | 'header' | 'body' | 'script' | 'tests';

export type PlaceholderReport = {
  name: string;
  used: PlaceholderUse[];
  resolved: boolean;
  scope: VariableScope | null;
  secret: boolean;
  /** Safe to render: a secret is never previewed, only measured. */
  preview: string;
};

const PREVIEW_LIMIT = 48;

function preview(entry: ResolvedVariable | undefined): string {
  if (!entry) return 'not set';
  if (entry.secret) {
    return `${'•'.repeat(Math.min(8, Math.max(1, entry.value.length)))} (${
      entry.value.length
    } characters, encrypted)`;
  }
  return entry.value.length > PREVIEW_LIMIT
    ? `${entry.value.slice(0, PREVIEW_LIMIT)}…`
    : entry.value;
}

/**
 * Every placeholder a request mentions, and what it would resolve to.
 *
 * Includes unresolved names on purpose: those are the interesting ones, since
 * substitution leaves them in the outgoing request as written.
 */
export function reportPlaceholders(
  parts: Partial<Record<PlaceholderUse, readonly string[]>>,
  resolution: VariableResolution,
  options: { scriptAssigned?: readonly string[] } = {},
): PlaceholderReport[] {
  const assigned = new Set(options.scriptAssigned ?? []);
  const uses = new Map<string, Set<PlaceholderUse>>();

  for (const [use, texts] of Object.entries(parts) as [
    PlaceholderUse,
    readonly string[] | undefined,
  ][]) {
    for (const text of texts ?? []) {
      for (const name of findPlaceholderNames(text)) {
        const set = uses.get(name) ?? new Set<PlaceholderUse>();
        set.add(use);
        uses.set(name, set);
      }
    }
  }

  return [...uses.entries()]
    .map(([name, used]) => {
      const entry = resolution.byName[name];
      // A script assignment wins the report for the same reason it wins
      // resolution: it happens last, just before the request is sent.
      if (!entry && assigned.has(name)) {
        return {
          name,
          used: [...used],
          resolved: true,
          scope: 'script' as VariableScope,
          secret: false,
          preview: 'set by the pre-request script',
        };
      }
      return {
        name,
        used: [...used],
        resolved: entry !== undefined,
        scope: entry?.scope ?? null,
        secret: entry?.secret ?? false,
        preview: preview(entry),
      };
    })
    .sort((a, b) => {
      // Unresolved first: they are the reason to open this view.
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
}

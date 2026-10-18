'use client';

import type { PlaceholderReport, VariableScope } from '@/lib/variables';

const SCOPE_LABELS: Record<VariableScope, string> = {
  collection: 'Collection',
  environment: 'Environment',
  script: 'Script or capture',
};

const USE_LABELS: Record<string, string> = {
  url: 'URL',
  header: 'Headers',
  body: 'Body',
  script: 'Script',
  tests: 'Tests',
};

/**
 * Where every {{variable}} in this request would come from.
 *
 * Unresolved placeholders are sent literally, which is the single most
 * confusing failure in a request client: the server rejects a token that looks
 * like "{{token}}" and nothing in the response explains why. Listing them,
 * unresolved first, answers that without guesswork.
 */
export function VariableReport({ reports }: { reports: readonly PlaceholderReport[] }) {
  if (reports.length === 0) {
    return (
      <p className="hint">
        This request uses no <code>{'{{variables}}'}</code>. Add one anywhere in
        the URL, a header or the body and it will be resolved from the
        collection, then the environment, then anything a script or capture set.
      </p>
    );
  }

  const unresolved = reports.filter((entry) => !entry.resolved).length;

  return (
    <div className="variableReport">
      <p className="settingsStatus">
        <span className={`badge ${unresolved === 0 ? 'good' : 'warn'}`}>
          {unresolved === 0 ? 'All resolved' : `${unresolved} unresolved`}
        </span>
        {unresolved === 0
          ? 'Every placeholder in this request has a value.'
          : 'An unresolved placeholder is sent exactly as written.'}
      </p>

      <ul className="variableList">
        {reports.map((entry) => (
          <li key={entry.name} className={entry.resolved ? '' : 'is-unresolved'}>
            <code>{`{{${entry.name}}}`}</code>
            <span className="variableSource">
              {entry.resolved ? SCOPE_LABELS[entry.scope ?? 'collection'] : 'Not set'}
            </span>
            <span className="variableValue">{entry.preview}</span>
            <span className="variableUses">
              {entry.used.map((use) => USE_LABELS[use] ?? use).join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

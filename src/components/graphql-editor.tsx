'use client';

import { useMemo, useState } from 'react';

import {
  buildGraphQLBody,
  buildOperation,
  GraphQLInputError,
  INTROSPECTION_QUERY,
  summariseSchema,
  type SchemaSummary,
} from '@/lib/graphql';

type GraphQLEditorProps = {
  /** The request body, which is the JSON payload actually sent. */
  body: string;
  onChange: (body: string) => void;
  /** Sends a document through the relay; used for introspection. */
  onIntrospect: (body: string) => Promise<string>;
};

type Decoded = { query: string; variables: string; operationName: string };

/**
 * A GraphQL document, its variables, and the schema behind them.
 *
 * The editor reads and writes the request's own body, which is the JSON
 * payload that will be sent, so nothing is stored twice and a saved request
 * reopens exactly as it was. Introspection goes through the relay like any
 * other request — a schema is just a POST.
 */
function decode(body: string): Decoded {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.query === 'string') {
      return {
        query: parsed.query,
        variables:
          parsed.variables && typeof parsed.variables === 'object'
            ? `${JSON.stringify(parsed.variables, null, 2)}\n`
            : '',
        operationName:
          typeof parsed.operationName === 'string' ? parsed.operationName : '',
      };
    }
  } catch {
    // Not a GraphQL payload yet; start from an empty document.
  }
  return { query: '', variables: '', operationName: '' };
}

export function GraphQLEditor({ body, onChange, onIntrospect }: GraphQLEditorProps) {
  const decoded = useMemo(() => decode(body), [body]);
  const [query, setQuery] = useState(decoded.query);
  const [variables, setVariables] = useState(decoded.variables);
  const [operationName, setOperationName] = useState(decoded.operationName);
  const [schema, setSchema] = useState<SchemaSummary | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  /*
   * The body is rewritten on every edit, so what is saved and what is sent are
   * the same text. An invalid variables block is reported and the body is left
   * alone rather than written half-formed.
   */
  const push = (next: Partial<Decoded>): void => {
    const merged = { query, variables, operationName, ...next };
    setQuery(merged.query);
    setVariables(merged.variables);
    setOperationName(merged.operationName);
    try {
      onChange(
        buildGraphQLBody({
          query: merged.query,
          variables: merged.variables,
          operationName: merged.operationName,
        }),
      );
      setError(null);
    } catch (problem) {
      setError(
        problem instanceof GraphQLInputError
          ? problem.message
          : 'Could not build the request body',
      );
    }
  };

  const introspect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const raw = await onIntrospect(
        JSON.stringify({ query: INTROSPECTION_QUERY, operationName: 'RelayIntrospection' }),
      );
      const summary = summariseSchema(raw);
      if (summary.queries.length === 0 && summary.mutations.length === 0) {
        setError('That endpoint returned no schema. Introspection may be disabled.');
        return;
      }
      setSchema(summary);
      setStatus(
        `${summary.queries.length} queries, ${summary.mutations.length} mutations, ${summary.typeCount} types`,
      );
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Introspection failed');
    } finally {
      setBusy(false);
    }
  };

  const fields = useMemo(() => {
    if (!schema) return [];
    const all = [
      ...schema.queries.map((field) => ({ field, kind: 'query' as const })),
      ...schema.mutations.map((field) => ({ field, kind: 'mutation' as const })),
    ];
    const needle = filter.trim().toLowerCase();
    return needle === ''
      ? all
      : all.filter((entry) => entry.field.name.toLowerCase().includes(needle));
  }, [schema, filter]);

  return (
    <div className="graphqlEditor">
      <div className="graphqlBar">
        <button type="button" disabled={busy} onClick={() => void introspect()}>
          {busy ? 'Introspecting…' : 'Introspect schema'}
        </button>
        {status ? <span className="hint">{status}</span> : null}
      </div>

      {error ? (
        <p className="notice bad" role="alert">
          {error}
        </p>
      ) : null}

      {schema ? (
        <div className="graphqlSchema">
          <div className="dialogField">
            <label htmlFor="graphql-filter">Fields</label>
            <input
              id="graphql-filter"
              placeholder="Filter by name"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <ul className="graphqlFields">
            {fields.slice(0, 40).map(({ field, kind }) => (
              <li key={`${kind}-${field.name}`}>
                <button
                  type="button"
                  onClick={() => {
                    const built = buildOperation(field, kind);
                    push({
                      query: built.document,
                      variables: built.variables,
                      operationName: '',
                    });
                  }}
                  title={field.description ?? undefined}
                >
                  <span className={`badge ${kind === 'mutation' ? 'warn' : 'good'}`}>
                    {kind === 'mutation' ? 'mut' : 'qry'}
                  </span>
                  <span className="truncate">{field.name}</span>
                  <span className="graphqlType truncate">{field.type}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="dialogField">
        <label htmlFor="graphql-query">Document</label>
        <textarea
          id="graphql-query"
          className="dialogCodeInput"
          spellCheck={false}
          placeholder={'query Me {\n  me {\n    id\n    email\n  }\n}'}
          value={query}
          onChange={(event) => push({ query: event.target.value })}
        />
      </div>

      <div className="dialogField">
        <label htmlFor="graphql-variables">Variables (JSON)</label>
        <textarea
          id="graphql-variables"
          spellCheck={false}
          placeholder={'{\n  "id": "7"\n}'}
          value={variables}
          onChange={(event) => push({ variables: event.target.value })}
        />
      </div>

      <div className="dialogField">
        <label htmlFor="graphql-operation">Operation name (optional)</label>
        <input
          id="graphql-operation"
          placeholder="Me"
          value={operationName}
          onChange={(event) => push({ operationName: event.target.value })}
        />
      </div>

      <p className="hint">
        Sent as <code>{'{ query, variables, operationName }'}</code> to the
        request URL with a POST. Remember that a GraphQL error arrives as HTTP
        200 — the response panel calls those out.
      </p>
    </div>
  );
}

/*
 * GraphQL support.
 *
 * A GraphQL endpoint is one URL that answers POSTs, so the relay already
 * carries it. What it needs on top is the three things that make the editor
 * usable: a document and variables sent in the shape servers expect,
 * introspection so the fields can be listed rather than remembered, and
 * errors surfaced — GraphQL answers 200 with an `errors` array, so a client
 * that only looks at the status reports success for a failed query.
 */

export const INTROSPECTION_QUERY = `query RelayIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: false) {
        name
        description
        args { name description type { ...TypeRef } }
        type { ...TypeRef }
      }
    }
  }
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType { kind name ofType { kind name } }
  }
}`;

export type GraphQLRequest = {
  query: string;
  variables?: string | undefined;
  operationName?: string | undefined;
};

export class GraphQLInputError extends Error {}

/** The POST body a GraphQL server expects, with the variables validated. */
export function buildGraphQLBody(request: GraphQLRequest): string {
  if (request.query.trim() === '') {
    throw new GraphQLInputError('The document is empty');
  }

  let variables: unknown;
  const raw = (request.variables ?? '').trim();
  if (raw !== '') {
    try {
      variables = JSON.parse(raw);
    } catch (error) {
      throw new GraphQLInputError(
        `Variables are not valid JSON: ${
          error instanceof Error ? error.message : 'parse error'
        }`,
      );
    }
    if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) {
      throw new GraphQLInputError('Variables must be a JSON object');
    }
  }

  return JSON.stringify({
    query: request.query,
    ...(variables ? { variables } : {}),
    ...(request.operationName?.trim() ? { operationName: request.operationName.trim() } : {}),
  });
}

type TypeRef = {
  kind?: string | null;
  name?: string | null;
  ofType?: TypeRef | null;
};

/** Renders a type reference the way it is written in a document: [Item!]! */
export function renderTypeRef(type: TypeRef | null | undefined): string {
  if (!type) return 'Unknown';
  if (type.kind === 'NON_NULL') return `${renderTypeRef(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${renderTypeRef(type.ofType)}]`;
  return type.name ?? 'Unknown';
}

function isNonNull(type: TypeRef | null | undefined): boolean {
  return type?.kind === 'NON_NULL';
}

/** True when a selection set is required: object-ish types need subfields. */
function needsSelection(type: TypeRef | null | undefined): boolean {
  if (!type) return false;
  if (type.kind === 'NON_NULL' || type.kind === 'LIST') return needsSelection(type.ofType);
  return type.kind === 'OBJECT' || type.kind === 'INTERFACE' || type.kind === 'UNION';
}

export type GraphQLArgument = {
  name: string;
  type: string;
  required: boolean;
};

export type GraphQLField = {
  name: string;
  description: string | null;
  type: string;
  args: GraphQLArgument[];
  needsSelection: boolean;
};

export type SchemaSummary = {
  queryType: string | null;
  mutationType: string | null;
  queries: GraphQLField[];
  mutations: GraphQLField[];
  typeCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads an introspection response into something a picker can render. */
export function summariseSchema(payload: unknown): SchemaSummary {
  const root = typeof payload === 'string' ? safeParse(payload) : payload;
  const data = isRecord(root) && isRecord(root.data) ? root.data : root;
  const schema = isRecord(data) && isRecord(data.__schema) ? data.__schema : null;
  if (!schema) {
    return { queryType: null, mutationType: null, queries: [], mutations: [], typeCount: 0 };
  }

  const queryType = isRecord(schema.queryType) ? (schema.queryType.name as string) : null;
  const mutationType = isRecord(schema.mutationType)
    ? (schema.mutationType.name as string)
    : null;
  const types = Array.isArray(schema.types) ? schema.types.filter(isRecord) : [];

  const fieldsOf = (typeName: string | null): GraphQLField[] => {
    if (!typeName) return [];
    const type = types.find((entry) => entry.name === typeName);
    const fields = type && Array.isArray(type.fields) ? type.fields.filter(isRecord) : [];
    return fields.map((field) => ({
      name: String(field.name ?? ''),
      description: typeof field.description === 'string' ? field.description : null,
      type: renderTypeRef(field.type as TypeRef),
      needsSelection: needsSelection(field.type as TypeRef),
      args: (Array.isArray(field.args) ? field.args.filter(isRecord) : []).map((arg) => ({
        name: String(arg.name ?? ''),
        type: renderTypeRef(arg.type as TypeRef),
        required: isNonNull(arg.type as TypeRef),
      })),
    }));
  };

  return {
    queryType,
    mutationType,
    queries: fieldsOf(queryType),
    mutations: fieldsOf(mutationType),
    // Introspection types (__Schema and friends) are not the API's own.
    typeCount: types.filter((type) => !String(type.name ?? '').startsWith('__')).length,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A runnable skeleton for one field: required arguments become declared
 * variables, so the variables pane has something to fill in rather than the
 * document carrying literals.
 */
export function buildOperation(
  field: GraphQLField,
  kind: 'query' | 'mutation',
): { document: string; variables: string } {
  const required = field.args.filter((arg) => arg.required);
  const declaration =
    required.length > 0
      ? `(${required.map((arg) => `$${arg.name}: ${arg.type}`).join(', ')})`
      : '';
  const call =
    required.length > 0
      ? `(${required.map((arg) => `${arg.name}: $${arg.name}`).join(', ')})`
      : '';
  const selection = field.needsSelection ? ' {\n      __typename\n    }' : '';
  const operationName = `${field.name.charAt(0).toUpperCase()}${field.name.slice(1)}`;

  const document = [
    `${kind} ${operationName}${declaration} {`,
    `  ${field.name}${call}${selection}`,
    '}',
    '',
  ].join('\n');

  const variables =
    required.length > 0
      ? `${JSON.stringify(
          Object.fromEntries(required.map((arg) => [arg.name, placeholderFor(arg.type)])),
          null,
          2,
        )}\n`
      : '';

  return { document, variables };
}

function placeholderFor(type: string): unknown {
  const bare = type.replace(/[![\]]/g, '');
  if (bare === 'Int' || bare === 'Float') return 0;
  if (bare === 'Boolean') return false;
  if (type.startsWith('[')) return [];
  return '';
}

export type GraphQLResultSummary = {
  isGraphQL: boolean;
  hasData: boolean;
  errors: { message: string; path: string | null }[];
};

/**
 * Reads a GraphQL response body.
 *
 * A failed query comes back as HTTP 200 with an `errors` array, which is why
 * this exists: without it the response panel would report a green 200 for a
 * query that returned nothing.
 */
export function summariseGraphQLResult(body: string): GraphQLResultSummary {
  const parsed = safeParse(body);
  if (!isRecord(parsed)) return { isGraphQL: false, hasData: false, errors: [] };

  const hasErrors = Array.isArray(parsed.errors);
  const hasDataKey = Object.prototype.hasOwnProperty.call(parsed, 'data');
  if (!hasErrors && !hasDataKey) {
    return { isGraphQL: false, hasData: false, errors: [] };
  }

  const errors = (hasErrors ? (parsed.errors as unknown[]) : [])
    .filter(isRecord)
    .map((error) => ({
      message:
        typeof error.message === 'string' ? error.message : 'Unnamed GraphQL error',
      path: Array.isArray(error.path) ? error.path.join('.') : null,
    }));

  return {
    isGraphQL: true,
    hasData: parsed.data !== null && parsed.data !== undefined,
    errors,
  };
}

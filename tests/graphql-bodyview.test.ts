import { describe, expect, it } from 'vitest';

import {
  defaultExpanded,
  detectBodyKind,
  hexdump,
  jsonTreeRows,
} from '../src/lib/body-view';
import {
  buildGraphQLBody,
  buildOperation,
  GraphQLInputError,
  INTROSPECTION_QUERY,
  renderTypeRef,
  summariseGraphQLResult,
  summariseSchema,
} from '../src/lib/graphql';

describe('buildGraphQLBody', () => {
  it('sends the document, parsed variables and the operation name', () => {
    const body = buildGraphQLBody({
      query: 'query X($id: ID!) { node(id: $id) { id } }',
      variables: '{"id":"7"}',
      operationName: ' X ',
    });
    expect(JSON.parse(body)).toEqual({
      query: 'query X($id: ID!) { node(id: $id) { id } }',
      variables: { id: '7' },
      operationName: 'X',
    });
  });

  it('omits variables and operationName when they are empty', () => {
    expect(JSON.parse(buildGraphQLBody({ query: '{ me { id } }', variables: '  ' }))).toEqual(
      { query: '{ me { id } }' },
    );
  });

  it('rejects an empty document and variables that are not a JSON object', () => {
    expect(() => buildGraphQLBody({ query: '   ' })).toThrow(GraphQLInputError);
    expect(() => buildGraphQLBody({ query: '{x}', variables: 'nope' })).toThrow(
      /not valid JSON/,
    );
    expect(() => buildGraphQLBody({ query: '{x}', variables: '[1]' })).toThrow(
      /must be a JSON object/,
    );
  });
});

describe('renderTypeRef', () => {
  it('writes types the way a document does', () => {
    expect(
      renderTypeRef({
        kind: 'NON_NULL',
        ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', ofType: { kind: 'OBJECT', name: 'Item' } } },
      }),
    ).toBe('[Item!]!');
    expect(renderTypeRef({ kind: 'SCALAR', name: 'String' })).toBe('String');
    expect(renderTypeRef(null)).toBe('Unknown');
  });
});

const INTROSPECTION = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'users',
              description: 'All users',
              type: {
                kind: 'NON_NULL',
                ofType: { kind: 'LIST', ofType: { kind: 'OBJECT', name: 'User' } },
              },
              args: [
                { name: 'first', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } } },
                { name: 'after', type: { kind: 'SCALAR', name: 'String' } },
              ],
            },
            {
              name: 'version',
              description: null,
              type: { kind: 'SCALAR', name: 'String' },
              args: [],
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Mutation',
          fields: [
            {
              name: 'deleteUser',
              type: { kind: 'SCALAR', name: 'Boolean' },
              args: [{ name: 'id', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'ID' } } }],
            },
          ],
        },
        { kind: 'OBJECT', name: 'User', fields: [] },
        { kind: 'OBJECT', name: '__Type', fields: [] },
      ],
    },
  },
};

describe('summariseSchema', () => {
  const summary = summariseSchema(INTROSPECTION);

  it('asks for what it needs in one introspection document', () => {
    expect(INTROSPECTION_QUERY).toContain('__schema');
    expect(INTROSPECTION_QUERY).toContain('fragment TypeRef');
  });

  it('lists query and mutation fields with rendered types', () => {
    expect(summary.queryType).toBe('Query');
    expect(summary.queries.map((field) => `${field.name}: ${field.type}`)).toEqual([
      'users: [User]!',
      'version: String',
    ]);
    expect(summary.mutations[0]?.name).toBe('deleteUser');
  });

  it('marks arguments that must be supplied', () => {
    const users = summary.queries[0];
    expect(users?.args).toEqual([
      { name: 'first', type: 'Int!', required: true },
      { name: 'after', type: 'String', required: false },
    ]);
    expect(users?.needsSelection).toBe(true);
    expect(summary.queries[1]?.needsSelection).toBe(false);
  });

  it('does not count introspection types as the API surface', () => {
    expect(summary.typeCount).toBe(3);
  });

  it('accepts a raw response string and shrugs off nonsense', () => {
    expect(summariseSchema(JSON.stringify(INTROSPECTION)).queries).toHaveLength(2);
    expect(summariseSchema('not json').queries).toEqual([]);
    expect(summariseSchema({ data: {} }).typeCount).toBe(0);
  });
});

describe('buildOperation', () => {
  it('declares required arguments as variables and selects subfields', () => {
    const summary = summariseSchema(INTROSPECTION);
    const { document, variables } = buildOperation(summary.queries[0]!, 'query');
    expect(document).toBe(
      ['query Users($first: Int!) {', '  users(first: $first) {', '      __typename', '    }', '}', ''].join(
        '\n',
      ),
    );
    expect(JSON.parse(variables)).toEqual({ first: 0 });
  });

  it('leaves a scalar field without a selection set or variables', () => {
    const summary = summariseSchema(INTROSPECTION);
    const { document, variables } = buildOperation(summary.queries[1]!, 'query');
    expect(document).toBe(['query Version {', '  version', '}', ''].join('\n'));
    expect(variables).toBe('');
  });
});

describe('summariseGraphQLResult', () => {
  it('finds errors in a 200 response', () => {
    const summary = summariseGraphQLResult(
      JSON.stringify({
        data: null,
        errors: [{ message: 'Not authorised', path: ['users', 0, 'email'] }],
      }),
    );
    expect(summary).toEqual({
      isGraphQL: true,
      hasData: false,
      errors: [{ message: 'Not authorised', path: 'users.0.email' }],
    });
  });

  it('reports a successful query as GraphQL with data and no errors', () => {
    expect(summariseGraphQLResult('{"data":{"me":{"id":"1"}}}')).toEqual({
      isGraphQL: true,
      hasData: true,
      errors: [],
    });
  });

  it('does not claim a plain REST body is GraphQL', () => {
    expect(summariseGraphQLResult('{"id":1}').isGraphQL).toBe(false);
    expect(summariseGraphQLResult('<html></html>').isGraphQL).toBe(false);
    expect(summariseGraphQLResult('').isGraphQL).toBe(false);
  });
});

describe('detectBodyKind', () => {
  it('believes a usable content type', () => {
    expect(detectBodyKind({ 'Content-Type': 'application/json' }, '{}')).toBe('json');
    expect(detectBodyKind({ 'content-type': 'text/html' }, '<p>x</p>')).toBe('html');
    expect(detectBodyKind({ 'content-type': 'image/png' }, 'binary')).toBe('image');
    expect(detectBodyKind({ 'content-type': 'application/xml' }, '<a/>')).toBe('xml');
  });

  it('sniffs when the content type is missing or unhelpful', () => {
    expect(detectBodyKind({}, '{"a":1}')).toBe('json');
    expect(detectBodyKind({ 'content-type': 'application/octet-stream' }, '[1,2]')).toBe(
      'json',
    );
    expect(detectBodyKind({}, '<!DOCTYPE html><html></html>')).toBe('html');
    expect(detectBodyKind({}, '<?xml version="1.0"?><a/>')).toBe('xml');
    expect(detectBodyKind({}, 'plain words')).toBe('text');
    expect(detectBodyKind({}, '')).toBe('empty');
  });

  it('does not call a broken JSON body JSON', () => {
    expect(detectBodyKind({}, '{"a":')).toBe('text');
  });

  it('recognises bytes that are not text', () => {
    const binary = Array.from({ length: 64 }, (_, index) =>
      String.fromCharCode(index % 8),
    ).join('');
    expect(detectBodyKind({ 'content-type': 'application/octet-stream' }, binary)).toBe(
      'binary',
    );
    // A declared text type is respected even with odd characters in it.
    expect(detectBodyKind({ 'content-type': 'text/plain' }, binary)).toBe('text');
  });
});

describe('hexdump', () => {
  it('lays out offset, hex and ascii columns', () => {
    const { lines, truncated, byteLength } = hexdump('Hi\u0000there, world!!');
    expect(truncated).toBe(false);
    expect(byteLength).toBe(17);
    expect(lines[0]?.offset).toBe('00000000');
    expect(lines[0]?.hex.startsWith('48 69 00 74 68 65 72 65')).toBe(true);
    expect(lines[0]?.ascii).toBe('Hi.there, world!');
    expect(lines[1]?.offset).toBe('00000010');
  });

  it('caps the dump and says that it did', () => {
    const { lines, truncated } = hexdump('x'.repeat(100), { limit: 32 });
    expect(truncated).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it('pads a short final line so the ascii column stays aligned', () => {
    const { lines } = hexdump('abc');
    expect(lines[0]?.hex).toHaveLength(16 * 3 - 1);
  });
});

describe('jsonTreeRows', () => {
  const document = {
    id: 1,
    name: 'Ada',
    'odd key': true,
    tags: ['a', 'b'],
    nested: { deep: { deeper: null } },
  };

  it('shows the root and its children when the root is open', () => {
    const { rows } = jsonTreeRows(document, new Set(['$']));
    expect(rows.map((row) => `${row.depth}:${row.label}:${row.preview}`)).toEqual([
      '0::{5}',
      '1:id:1',
      '1:name:"Ada"',
      '1:odd key:true',
      '1:tags:[2]',
      '1:nested:{1}',
    ]);
  });

  it('expands only the paths it is told to', () => {
    const { rows } = jsonTreeRows(document, new Set(['$', '$.tags']));
    expect(rows.find((row) => row.path === '$.tags[1]')?.preview).toBe('"b"');
    expect(rows.some((row) => row.path.startsWith('$.nested.'))).toBe(false);
  });

  it('quotes a key that a dotted path cannot express', () => {
    const { rows } = jsonTreeRows(document, new Set(['$']));
    expect(rows.find((row) => row.label === 'odd key')?.path).toBe("$['odd key']");
  });

  it('stops at the row limit rather than locking the tab', () => {
    const wide = Array.from({ length: 500 }, (_, index) => index);
    const { rows, truncated } = jsonTreeRows(wide, new Set(['$']), 50);
    expect(truncated).toBe(true);
    expect(rows).toHaveLength(50);
  });

  it('opens containers one level deep by default', () => {
    expect([...defaultExpanded(document)].sort()).toEqual(['$', '$.nested', '$.tags']);
    expect([...defaultExpanded([{ a: 1 }])].sort()).toEqual(['$', '$[0]']);
    expect([...defaultExpanded('scalar')]).toEqual(['$']);
  });
});

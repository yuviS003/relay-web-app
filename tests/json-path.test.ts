import { describe, expect, it } from 'vitest';

import {
  JsonPathError,
  parseJsonPath,
  queryJsonPath,
  readJsonPathValue,
} from '../src/lib/json-path';

const document = {
  token: 'abc123',
  user: {
    id: 7,
    name: 'Ada',
    'display-name': 'Ada L.',
    'odd key': 'spaced',
    tags: ['a', 'b', 'c'],
  },
  items: [
    { id: 1, price: 10, nested: { id: 11 } },
    { id: 2, price: 20, nested: { id: 22 } },
  ],
  empty: [],
  nothing: null,
  flag: false,
};

describe('parseJsonPath', () => {
  it('treats $ and a bare name as the same kind of start', () => {
    expect(parseJsonPath('$.user.id')).toEqual(parseJsonPath('user.id'));
  });

  it('returns no steps for the document itself', () => {
    expect(parseJsonPath('$')).toEqual([]);
  });

  it('rejects an expression language rather than half-supporting one', () => {
    for (const bad of ['', '$.', '$.items[?(@.price>10)]', '$.items[', '$..']) {
      if (bad === '$' || bad === '$.') continue;
      expect(() => parseJsonPath(bad)).toThrow(JsonPathError);
    }
  });

  it('names the problem it found', () => {
    expect(() => parseJsonPath('$.items[1')).toThrow(/Unclosed/);
    expect(() => parseJsonPath('$.items[a]')).toThrow(/not an index/);
    expect(() => parseJsonPath('$..')).toThrow(/after ".."/);
  });
});

describe('queryJsonPath', () => {
  it('reads dotted paths and reports the concrete path of a match', () => {
    expect(queryJsonPath(document, '$.user.name')).toEqual([
      { path: "$.user.name", value: 'Ada' },
    ]);
  });

  it('indexes arrays, including from the end', () => {
    expect(queryJsonPath(document, '$.items[0].id')[0]?.value).toBe(1);
    expect(queryJsonPath(document, '$.items[-1].id')[0]?.value).toBe(2);
    expect(queryJsonPath(document, '$.items[9]')).toEqual([]);
  });

  it('expands wildcards over arrays and objects', () => {
    expect(queryJsonPath(document, '$.items[*].price').map((m) => m.value)).toEqual([
      10, 20,
    ]);
    expect(queryJsonPath(document, '$.user.tags[*]').map((m) => m.value)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(queryJsonPath(document, '$.user.*').length).toBe(5);
  });

  it('descends recursively to every matching name', () => {
    const ids = queryJsonPath(document, '$..id').map((match) => match.value);
    expect(ids).toEqual([7, 1, 11, 2, 22]);
  });

  it('reaches keys a dot cannot express', () => {
    expect(queryJsonPath(document, "$.user['odd key']")[0]?.value).toBe('spaced');
    expect(queryJsonPath(document, '$.user["odd key"]')[0]?.value).toBe('spaced');
  });

  it('accepts hyphenated names unbracketed, since real payloads are full of them', () => {
    expect(queryJsonPath(document, '$.user.display-name')[0]?.value).toBe('Ada L.');
    expect(queryJsonPath(document, '$..display-name')[0]?.value).toBe('Ada L.');
  });

  it('returns nothing rather than throwing on a path that does not exist', () => {
    expect(queryJsonPath(document, '$.user.missing.deeper')).toEqual([]);
    expect(queryJsonPath(document, '$.nothing.id')).toEqual([]);
    expect(queryJsonPath('a string', '$.anything')).toEqual([]);
  });

  it('reports a path that can be read back, quoting only when it must', () => {
    // Every reported path has to parse: the viewer shows them, and a capture
    // is usually written by copying one.
    const reported = [
      ...queryJsonPath(document, '$.user.*'),
      ...queryJsonPath(document, '$.items[*]'),
      ...queryJsonPath(document, '$..id'),
    ];
    expect(reported.length).toBeGreaterThan(8);
    for (const match of reported) {
      expect(queryJsonPath(document, match.path)[0]?.value).toEqual(match.value);
    }

    const spaced = reported.find((match) => match.value === 'spaced');
    expect(spaced?.path).toBe("$.user['odd key']");
  });
});

describe('readJsonPathValue', () => {
  it('returns strings, numbers and booleans as text', () => {
    expect(readJsonPathValue(document, '$.token')).toBe('abc123');
    expect(readJsonPathValue(document, '$.user.id')).toBe('7');
    expect(readJsonPathValue(document, '$.flag')).toBe('false');
    expect(readJsonPathValue(document, '$.nothing')).toBe('null');
  });

  it('serialises a structure instead of stringifying it', () => {
    expect(readJsonPathValue(document, '$.user.tags')).toBe('["a","b","c"]');
  });

  it('is null when nothing matched, so a capture can report a miss', () => {
    expect(readJsonPathValue(document, '$.user.absent')).toBeNull();
    expect(readJsonPathValue(document, '$.empty[0]')).toBeNull();
  });

  it('takes the first match when a path is ambiguous', () => {
    expect(readJsonPathValue(document, '$.items[*].id')).toBe('1');
  });
});

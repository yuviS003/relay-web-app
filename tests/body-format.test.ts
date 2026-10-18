// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { formatBody } from '../src/lib/body-format';
import { parseRequestSpec } from '../src/lib/store/types';

describe('body formatting', () => {
  it('formats and minifies JSON', () => {
    expect(formatBody('json', '{"a":1,"b":[2]}', false)).toEqual({
      ok: true,
      value: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    });
    expect(formatBody('json', '{\n "a": 1 \n}', true)).toEqual({
      ok: true,
      value: '{"a":1}',
    });
  });

  it('reports invalid JSON rather than destroying it', () => {
    const result = formatBody('json', '{bad', false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid JSON');
  });

  it('formats and compacts XML', () => {
    const pretty = formatBody('xml', '<root><key>value</key></root>', false);
    expect(pretty.ok).toBe(true);
    if (pretty.ok) expect(pretty.value).toContain('\n  <key>value</key>');
    expect(formatBody('xml', '<root>  <key>value</key> </root>', true)).toEqual({
      ok: true,
      value: '<root><key>value</key></root>',
    });
  });

  it('normalises forms and plain text', () => {
    expect(formatBody('form', 'a=1 & b=hello world', false)).toEqual({
      ok: true,
      value: 'a=1&b=hello+world',
    });
    expect(formatBody('text', ' one  \n\n two ', true)).toEqual({
      ok: true,
      value: 'one two',
    });
  });
});

describe('per-format body drafts', () => {
  it('validates and preserves body mode drafts in saved requests', () => {
    const parsed = parseRequestSpec(
      {
        id: 'drafts',
        name: 'Drafts',
        method: 'POST',
        url: 'https://example.com',
        headers: [{ name: 'content-type', value: 'application/json', enabled: true }],
        body: '{"json":true}',
        bodyMode: 'json',
        bodyDrafts: {
          json: '{"json":true}',
          xml: '<root/>',
          text: 'hello',
          none: '',
        },
        preRequestScript: '',
        testScript: '',
      },
      'request',
    );
    expect(parsed.bodyMode).toBe('json');
    expect(parsed.bodyDrafts?.xml).toBe('<root/>');
  });

  it('rejects an unknown body mode', () => {
    expect(() =>
      parseRequestSpec(
        {
          id: 'bad-mode', name: 'Bad', method: 'POST', url: '', headers: [], body: '',
          bodyMode: 'yaml', preRequestScript: '', testScript: '',
        },
        'request',
      ),
    ).toThrow(/bodyMode/);
  });
});

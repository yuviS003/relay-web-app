import { describe, expect, it } from 'vitest';

import { parseCurl, tokenise } from '../src/lib/import/curl';
import { runAssertions, type ResponseContext } from '../src/lib/scripting/assertions';

describe('shell tokeniser', () => {
  it('keeps quoted spaces together', () => {
    // Splitting on whitespace breaks immediately, because a header value has
    // a space in it: -H 'content-type: application/json'.
    expect(tokenise(`curl -H 'content-type: application/json' https://x.test`)).toEqual([
      'curl',
      '-H',
      'content-type: application/json',
      'https://x.test',
    ]);
  });

  it('treats single quotes as fully literal', () => {
    expect(tokenise(`curl -d 'a\\nb'`)).toEqual(['curl', '-d', 'a\\nb']);
  });

  it('honours escapes inside double quotes only', () => {
    expect(tokenise(`curl -d "say \\"hi\\""`)).toEqual(['curl', '-d', 'say "hi"']);
  });

  it('joins backslash-newline continuations', () => {
    // How every pasted curl command is formatted.
    const input = "curl -X POST \\\n  -H 'a: b' \\\n  https://x.test";
    expect(tokenise(input)).toEqual(['curl', '-X', 'POST', '-H', 'a: b', 'https://x.test']);
  });

  it('preserves an intentionally empty argument', () => {
    expect(tokenise(`curl -d '' https://x.test`)).toEqual(['curl', '-d', '', 'https://x.test']);
  });

  it('reports an unbalanced quote instead of guessing', () => {
    expect(tokenise(`curl -H 'unterminated`)).toBeNull();
  });
});

describe('curl import', () => {
  it('parses a realistic devtools copy', () => {
    const result = parseCurl(`curl 'https://api.example.com/v1/items?page=2' \\
      -H 'accept: application/json' \\
      -H 'authorization: Bearer abc123' \\
      --compressed`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.method).toBe('GET');
    expect(result.request.url).toBe('https://api.example.com/v1/items?page=2');
    expect(result.request.headers).toHaveLength(2);
    expect(result.request.ignored).toContain('--compressed');
  });

  it('infers POST when data is present and no method is given', () => {
    // curl's own behaviour; a client that defaulted to GET would quietly
    // drop the body.
    const result = parseCurl(`curl https://x.test -d 'a=1&b=2'`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.method).toBe('POST');
      expect(result.request.body).toBe('a=1&b=2');
    }
  });

  it('defaults the content type for -d, as curl does', () => {
    const result = parseCurl(`curl https://x.test -d 'a=1'`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Forgetting this is a 415 and ten minutes of confusion.
      expect(
        result.request.headers.find((h) => h.name === 'content-type')?.value,
      ).toBe('application/x-www-form-urlencoded');
    }
  });

  it('does not override an explicit content type', () => {
    const result = parseCurl(
      `curl https://x.test -H 'content-type: application/json' -d '{"a":1}'`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const types = result.request.headers.filter((h) => h.name === 'content-type');
      expect(types).toHaveLength(1);
      expect(types[0]?.value).toBe('application/json');
    }
  });

  it('concatenates repeated -d flags the way curl does', () => {
    const result = parseCurl(`curl https://x.test -d 'a=1' -d '&b=2'`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.body).toBe('a=1&b=2');
  });

  it('finds the URL wherever it appears', () => {
    const result = parseCurl(`curl -X PUT https://x.test/thing -H 'a: b'`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.url).toBe('https://x.test/thing');
      expect(result.request.method).toBe('PUT');
    }
  });

  it('handles --url and inline long-flag values', () => {
    const result = parseCurl(`curl --url=https://x.test --header='x-a: 1'`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.url).toBe('https://x.test');
      expect(result.request.headers[0]?.name).toBe('x-a');
    }
  });

  it('adds a scheme when one is missing', () => {
    const result = parseCurl('curl example.com/api');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.url).toBe('https://example.com/api');
  });

  it('maps -I to HEAD and -G to GET', () => {
    const head = parseCurl('curl -I https://x.test');
    expect(head.ok && head.request.method).toBe('HEAD');
    const get = parseCurl(`curl -G https://x.test -d 'a=1'`);
    expect(get.ok && get.request.method).toBe('GET');
  });

  it('flags multipart rather than silently sending the wrong thing', () => {
    const result = parseCurl(`curl https://x.test -F 'file=@a.txt'`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.ignored.join(' ')).toContain('multipart');
    }
  });

  it('refuses input that is not curl', () => {
    expect(parseCurl('wget https://x.test').ok).toBe(false);
    expect(parseCurl('').ok).toBe(false);
    expect(parseCurl('curl -X POST').ok).toBe(false);
  });
});

const response: ResponseContext = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: '{"id":7,"name":"thing","tags":["a","b"]}',
  durationMs: 120,
};

describe('response assertions', () => {
  it('reports each test independently', async () => {
    const run = await runAssertions(
      `test('status', () => expect(response.status).toBe(200));
       test('fails on purpose', () => expect(response.status).toBe(404));`,
      response,
    );

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // A failing assertion must not stop the rest; the point of a suite is
    // seeing everything wrong in one run.
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(1);
    expect(run.results[1]?.error).toContain('expected 404');
  });

  it('parses JSON lazily and exposes it', async () => {
    const run = await runAssertions(
      `test('body', () => {
         expect(response.json().id).toBe(7);
         expect(response.json().tags).toContain('b');
         expect(response.json()).toHaveProperty('name');
       });`,
      response,
    );
    expect(run.ok && run.passed).toBe(1);
  });

  it('reports a clear error for a non-JSON body instead of failing the run', async () => {
    const run = await runAssertions(`test('json', () => response.json());`, {
      ...response,
      body: 'not json at all',
    });
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.failed).toBe(1);
      expect(run.results[0]?.error).toContain('not valid JSON');
    }
  });

  it('looks headers up case-insensitively', async () => {
    const run = await runAssertions(
      `test('ct', () => expect(response.header('Content-Type')).toContain('json'));`,
      response,
    );
    expect(run.ok && run.passed).toBe(1);
  });

  it('compares objects structurally', async () => {
    const run = await runAssertions(
      `test('deep', () => expect(response.json().tags).toEqual(['a','b']));
       test('deep fails', () => expect(response.json().tags).toEqual(['a']));`,
      response,
    );
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.passed).toBe(1);
      expect(run.failed).toBe(1);
    }
  });

  it('captures console output', async () => {
    const run = await runAssertions(`console.log('seen', 1);`, response);
    expect(run.ok && run.logs).toContain('seen 1');
  });

  it('has no host access, exactly like the pre-request sandbox', async () => {
    const run = await runAssertions(
      `test('sealed', () => {
         expect(typeof require).toBe('undefined');
         expect(typeof process).toBe('undefined');
         expect(typeof fetch).toBe('undefined');
       });`,
      response,
    );
    expect(run.ok && run.passed).toBe(1);
  });

  it('stops an infinite loop', async () => {
    const run = await runAssertions(`while (true) {}`, response);
    expect(run.ok).toBe(false);
  }, 20_000);

  it('returns an empty run for an empty script', async () => {
    const run = await runAssertions('   ', response);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.results).toHaveLength(0);
  });

  it('truncates a huge body rather than exhausting the VM', async () => {
    const run = await runAssertions(
      `test('big', () => expect(response.body.length).toBeGreaterThan(1000));`,
      { ...response, body: 'x'.repeat(2 * 1024 * 1024) },
    );
    expect(run.ok && run.passed).toBe(1);
  }, 20_000);
});

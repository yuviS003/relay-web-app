import { describe, expect, it } from 'vitest';

import {
  defaultBodyMode,
  defaultHeaders,
  methodSendsBody,
} from '../src/lib/request-defaults';
import { HTTP_METHODS, parseRequestSpec } from '../src/lib/store/types';

const names = (method: string) => defaultHeaders(method).map((header) => header.name);

describe('default request headers', () => {
  it('seeds Accept and Cache-Control on every method', () => {
    for (const method of HTTP_METHODS) {
      expect(names(method), method).toContain('accept');
      expect(names(method), method).toContain('cache-control');
    }
  });

  it('adds Content-Type only for methods that carry a body', () => {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      expect(methodSendsBody(method), method).toBe(true);
      expect(names(method), method).toContain('content-type');
      // Content-Type leads so it sits beside the body editor's format control.
      expect(names(method)[0], method).toBe('content-type');
      expect(defaultBodyMode(method), method).toBe('json');
    }
    for (const method of ['GET', 'HEAD', 'DELETE', 'OPTIONS']) {
      expect(methodSendsBody(method), method).toBe(false);
      expect(names(method), method).not.toContain('content-type');
      expect(defaultBodyMode(method), method).toBe('none');
    }
  });

  it('is case and whitespace insensitive about the method', () => {
    expect(methodSendsBody(' post ')).toBe(true);
    expect(names('post')).toContain('content-type');
  });

  it('returns enabled, independently mutable rows', () => {
    const first = defaultHeaders('POST');
    expect(first.every((header) => header.enabled)).toBe(true);
    first[0]!.value = 'text/plain';
    // A shared array would leak an edit into the next request created.
    expect(defaultHeaders('POST')[0]?.value).toBe('application/json');
  });

  it('produces headers the store accepts', () => {
    for (const method of HTTP_METHODS) {
      const parsed = parseRequestSpec(
        {
          id: 'defaults',
          name: 'Defaults',
          method,
          url: 'https://api.example.com/v1/items',
          headers: defaultHeaders(method),
          body: '',
          bodyMode: defaultBodyMode(method),
          preRequestScript: '',
          testScript: '',
        },
        'request',
      );
      expect(parsed.headers.length, method).toBeGreaterThanOrEqual(2);
      expect(parsed.bodyMode, method).toBe(defaultBodyMode(method));
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  bodySignature,
  summarizeLoad,
  validateLoadPlan,
  type LoadSample,
} from '../src/lib/testing/load';
import {
  auditCors,
  auditMethods,
  auditResponse,
  securityScore,
} from '../src/lib/testing/security';

describe('load summaries', () => {
  const sample = (
    durationMs: number,
    status = 200,
    signature = 'same',
  ): LoadSample => ({
    index: durationMs,
    status,
    durationMs,
    bodyBytes: 10,
    bodySignature: signature,
    error: status === 0 ? 'network' : null,
  });

  it('calculates nearest-rank percentiles over sorted latency', () => {
    const samples = Array.from({ length: 20 }, (_, index) => sample(index + 1));
    const summary = summarizeLoad(samples, 2000);
    expect(summary.p50Ms).toBe(10);
    expect(summary.p95Ms).toBe(19);
    expect(summary.p99Ms).toBe(20);
    expect(summary.averageMs).toBe(11);
  });

  it('counts status distribution and errors', () => {
    const summary = summarizeLoad(
      [sample(10, 200), sample(12, 201), sample(8, 429), sample(5, 0)],
      1000,
    );
    expect(summary.statuses).toEqual({ '200': 1, '201': 1, '429': 1, 'network error': 1 });
    expect(summary.failed).toBe(2);
    expect(summary.errorRate).toBe(0.5);
    expect(summary.requestsPerSecond).toBe(4);
  });

  it('detects response drift without retaining bodies', () => {
    const summary = summarizeLoad(
      [sample(10, 200, 'a'), sample(11, 200, 'a'), sample(12, 200, 'b')],
      100,
    );
    expect(summary.bodyVariants).toBe(2);
  });

  it('is well-defined for an empty run', () => {
    expect(summarizeLoad([], 0)).toMatchObject({
      total: 0,
      p50Ms: 0,
      errorRate: 0,
      requestsPerSecond: 0,
      bodyVariants: 0,
    });
  });

  it('produces stable body signatures', () => {
    expect(bodySignature('same')).toBe(bodySignature('same'));
    expect(bodySignature('same')).not.toBe(bodySignature('different'));
  });

  it('enforces bounded plans', () => {
    expect(validateLoadPlan({ count: 20, concurrency: 3, delayMs: 100 })).toBeNull();
    expect(validateLoadPlan({ count: 51, concurrency: 1, delayMs: 100 })).toContain('1 to 50');
    expect(validateLoadPlan({ count: 10, concurrency: 6, delayMs: 100 })).toContain('1 to 5');
    expect(validateLoadPlan({ count: 10, concurrency: 1, delayMs: 0 })).toContain('50ms');
    expect(validateLoadPlan({ count: 2.5, concurrency: 1, delayMs: 100 })).not.toBeNull();
  });
});

describe('passive security audit', () => {
  it('passes a hardened HTTPS response', () => {
    const findings = auditResponse({
      url: 'https://example.test',
      status: 200,
      body: '<html></html>',
      headers: {
        'content-type': 'text/html',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'geolocation=()',
        'cross-origin-opener-policy': 'same-origin',
      },
    });
    expect(findings.every((finding) => finding.severity === 'pass')).toBe(true);
    expect(securityScore(findings)).toBe(100);
  });

  it('finds missing browser boundaries on HTML', () => {
    const findings = auditResponse({
      url: 'https://example.test',
      status: 200,
      body: '<html></html>',
      headers: { 'content-type': 'text/html', server: 'Express/4.0' },
    });
    expect(findings.find((finding) => finding.id === 'hsts')?.severity).toBe('medium');
    expect(findings.find((finding) => finding.id === 'csp')?.severity).toBe('medium');
    expect(findings.find((finding) => finding.id === 'frame')?.severity).toBe('medium');
    expect(findings.find((finding) => finding.id === 'server-disclosure')?.severity).toBe('low');
    expect(securityScore(findings)).toBeLessThan(100);
  });

  it('does not demand a CSP from a JSON API response', () => {
    const findings = auditResponse({
      url: 'https://api.example.test',
      status: 200,
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(findings.some((finding) => finding.id === 'csp')).toBe(false);
  });

  it('finds insecure cookie attributes', () => {
    const findings = auditResponse({
      url: 'https://example.test',
      status: 200,
      body: '',
      headers: { 'set-cookie': 'session=abc; Path=/' },
    });
    expect(findings.find((finding) => finding.id === 'cookie-http-only')?.severity).toBe('high');
    expect(findings.find((finding) => finding.id === 'cookie-secure')?.severity).toBe('high');
    expect(findings.find((finding) => finding.id === 'cookie-samesite')?.severity).toBe('medium');
  });

  it('flags credential-shaped content for manual review', () => {
    const findings = auditResponse({
      url: 'https://api.example.test',
      status: 200,
      headers: {},
      body: '-----BEGIN PRIVATE KEY-----\nabc',
    });
    expect(findings.find((finding) => finding.id === 'secret-pattern')?.severity).toBe('high');
  });

  it('flags a CSP weakened by unsafe-inline', () => {
    const findings = auditResponse({
      url: 'https://example.test',
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-security-policy': "script-src 'self' 'unsafe-inline'",
      },
      body: '<html></html>',
    });
    const quality = findings.find((f) => f.id === 'csp-quality');
    expect(quality?.severity).toBe('medium');
    expect(quality?.detail).toContain('unsafe-inline');
  });

  it('flags a short HSTS max-age and missing permissions policy', () => {
    const findings = auditResponse({
      url: 'https://example.test',
      status: 200,
      headers: {
        'content-type': 'text/html',
        'strict-transport-security': 'max-age=600',
      },
      body: '<html></html>',
    });
    expect(findings.find((f) => f.id === 'hsts-depth')?.severity).toBe('low');
    expect(findings.find((f) => f.id === 'permissions-policy')?.severity).toBe('low');
  });

  it('flags SameSite=None cookies without Secure', () => {
    const findings = auditResponse({
      url: 'https://example.test',
      status: 200,
      headers: { 'set-cookie': 'id=1; HttpOnly; SameSite=None' },
      body: '',
    });
    expect(findings.find((f) => f.id === 'cookie-samesite-none')?.severity).toBe('high');
  });
});

describe('HTTP method enumeration', () => {
  it('reports advertised methods and flags TRACE', () => {
    const findings = auditMethods({ allow: 'GET, POST, TRACE, DELETE' });
    expect(findings.find((f) => f.id === 'methods')?.detail).toContain('TRACE');
    expect(findings.find((f) => f.id === 'methods-trace')?.severity).toBe('medium');
    expect(findings.find((f) => f.id === 'methods-write')?.detail).toContain('DELETE');
  });

  it('falls back to the CORS methods header and dedupes', () => {
    const findings = auditMethods({
      'access-control-allow-methods': 'GET, GET, OPTIONS',
    });
    expect(findings.find((f) => f.id === 'methods')?.detail).toBe(
      'The target advertises: GET, OPTIONS.',
    );
  });

  it('returns nothing when no methods are advertised', () => {
    expect(auditMethods({})).toEqual([]);
  });
});

describe('CORS audit', () => {
  const origin = 'https://relay-audit.invalid';

  it('passes when the probe origin is not allowed', () => {
    expect(auditCors({}, origin)[0]?.severity).toBe('pass');
  });

  it('flags reflected credentialed origins high', () => {
    const finding = auditCors(
      {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
      },
      origin,
    )[0];
    expect(finding?.severity).toBe('high');
  });

  it('flags a wildcard and distinguishes credentialed policy', () => {
    expect(auditCors({ 'access-control-allow-origin': '*' }, origin)[0]?.severity).toBe('medium');
    expect(
      auditCors(
        {
          'access-control-allow-origin': '*',
          'access-control-allow-credentials': 'true',
        },
        origin,
      )[0]?.severity,
    ).toBe('high');
  });

  it('passes a different specific origin', () => {
    expect(
      auditCors({ 'access-control-allow-origin': 'https://app.example.com' }, origin)[0]?.severity,
    ).toBe('pass');
  });
});

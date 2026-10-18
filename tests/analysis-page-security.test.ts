// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { parseHtml, type ResponseContext } from '../src/lib/analysis/html';
import { auditPageBody } from '../src/lib/analysis/page-security';

const httpsCtx: ResponseContext = {
  finalUrl: 'https://example.com/',
  status: 200,
  headers: { 'content-type': 'text/html' },
};

function ids(html: string, ctx = httpsCtx): string[] {
  return auditPageBody(parseHtml(html), ctx).map((finding) => finding.id);
}

function severity(html: string, id: string, ctx = httpsCtx): string | undefined {
  return auditPageBody(parseHtml(html), ctx).find((f) => f.id === id)?.severity;
}

describe('page-body security audit', () => {
  it('flags mixed content on an HTTPS page', () => {
    const html = `<html><body>
      <script src="http://cdn.evil/x.js"></script>
      <img src="https://ok.example/i.png">
    </body></html>`;
    expect(severity(html, 'mixed-content')).toBe('high');
  });

  it('passes a clean HTTPS page with no mixed content', () => {
    const html = `<html><body>
      <script src="https://cdn.example/x.js"></script>
      <img src="/i.png">
    </body></html>`;
    expect(severity(html, 'mixed-content')).toBe('pass');
  });

  it('flags target=_blank links without rel=noopener', () => {
    const html = `<html><body>
      <a href="https://x.test" target="_blank">risky</a>
      <a href="https://y.test" target="_blank" rel="noopener">safe</a>
    </body></html>`;
    const findings = auditPageBody(parseHtml(html), httpsCtx);
    const tab = findings.find((f) => f.id === 'tabnabbing');
    expect(tab).toBeDefined();
    expect(tab?.detail).toContain('1');
  });

  it('flags a password form that posts over HTTP', () => {
    const html = `<html><body>
      <form action="http://insecure.example/login" method="post">
        <input type="password" name="pw">
      </form>
    </body></html>`;
    expect(severity(html, 'password-plaintext')).toBe('high');
  });

  it('reports third-party script origins', () => {
    const html = `<html><body>
      <script src="https://cdn.first.test/a.js"></script>
      <script src="https://cdn.second.test/b.js"></script>
      <script src="/local.js"></script>
    </body></html>`;
    const finding = auditPageBody(parseHtml(html), httpsCtx).find(
      (f) => f.id === 'third-party-scripts',
    );
    expect(finding?.detail).toContain('2');
  });

  it('flags inline event handlers and meta refresh', () => {
    const html = `<html><head>
      <meta http-equiv="refresh" content="0; url=/elsewhere">
      </head><body>
      <button onclick="go()">x</button>
    </body></html>`;
    const found = ids(html);
    expect(found).toContain('inline-handlers');
    expect(found).toContain('meta-refresh');
  });

  it('does not report mixed content for an HTTP page', () => {
    const html = `<html><body><img src="http://x/i.png"></body></html>`;
    const found = ids(html, {
      finalUrl: 'http://example.com/',
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    expect(found).not.toContain('mixed-content');
  });

  it('flags external scripts missing Subresource Integrity', () => {
    const html = `<html><body>
      <script src="https://cdn.external.test/a.js"></script>
      <script src="https://cdn.external.test/b.js" integrity="sha384-xxx"></script>
    </body></html>`;
    const finding = auditPageBody(parseHtml(html), httpsCtx).find(
      (f) => f.id === 'sri-missing',
    );
    expect(finding?.severity).toBe('low');
    expect(finding?.detail).toContain('1');
  });
});

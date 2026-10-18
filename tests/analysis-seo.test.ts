// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { parseHtml, type ResponseContext } from '../src/lib/analysis/html';
import { analyzeSeo, type SeoStatus } from '../src/lib/analysis/seo';

const paragraph = `${'word '.repeat(220)}`.trim();

const strongPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>A clear, descriptive page title about widgets</title>
  <meta name="description" content="This description is deliberately written to sit comfortably within the fifty to one hundred and sixty character window search engines prefer to show.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="/widgets">
  <meta property="og:title" content="Widgets">
  <meta property="og:description" content="All about widgets">
  <meta property="og:image" content="/og.png">
  <script type="application/ld+json">{"@type":"Article","headline":"Widgets"}</script>
</head>
<body>
  <h1>Everything about widgets</h1>
  <h2>History</h2>
  <p>${paragraph}</p>
  <h2>Usage</h2>
  <img src="/a.png" alt="A widget">
  <a href="/more">Internal</a>
  <a href="https://example.org/ref">External</a>
</body>
</html>`;

const weakPage = `<!doctype html>
<html>
<head></head>
<body>
  <h2>Subhead with no h1</h2>
  <h4>Skipped a level</h4>
  <img src="/a.png">
  <img src="/b.png">
  <p>Thin.</p>
</body>
</html>`;

function statusOf(html: string, id: string, ctx: ResponseContext): SeoStatus {
  const report = analyzeSeo(parseHtml(html), ctx);
  const check = report.checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`No SEO check with id ${id}`);
  return check.status;
}

describe('SEO analysis', () => {
  const httpsCtx: ResponseContext = {
    finalUrl: 'https://example.com/widgets',
    status: 200,
    headers: { 'content-type': 'text/html' },
  };
  const httpCtx: ResponseContext = {
    finalUrl: 'http://example.com/page',
    status: 200,
    headers: { 'content-type': 'text/html' },
  };

  it('detects the key facts from a well-formed page', () => {
    const report = analyzeSeo(parseHtml(strongPage), httpsCtx);
    expect(report.facts.title).toContain('widgets');
    expect(report.facts.h1).toEqual(['Everything about widgets']);
    expect(report.facts.canonical).toBe('https://example.com/widgets');
    expect(report.facts.lang).toBe('en');
    expect(report.facts.openGraph).toEqual([
      'og:title',
      'og:description',
      'og:image',
    ]);
    expect(report.facts.structuredDataTypes).toContain('Article');
    expect(report.facts.links).toEqual({ internal: 1, external: 1, nofollow: 0 });
    expect(report.facts.indexable).toBe(true);
    expect(report.facts.words).toBeGreaterThan(200);
  });

  it('grades a strong page well above a weak one', () => {
    const strong = analyzeSeo(parseHtml(strongPage), httpsCtx);
    const weak = analyzeSeo(parseHtml(weakPage), httpCtx);
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.grade).toBe('A');
    expect(weak.score).toBeLessThan(60);
  });

  it('judges individual signals', () => {
    expect(statusOf(strongPage, 'title', httpsCtx)).toBe('good');
    expect(statusOf(strongPage, 'open-graph', httpsCtx)).toBe('good');
    expect(statusOf(strongPage, 'https', httpsCtx)).toBe('good');

    expect(statusOf(weakPage, 'title', httpCtx)).toBe('bad');
    expect(statusOf(weakPage, 'h1', httpCtx)).toBe('bad');
    expect(statusOf(weakPage, 'viewport', httpCtx)).toBe('bad');
    expect(statusOf(weakPage, 'https', httpCtx)).toBe('bad');
    expect(statusOf(weakPage, 'headings', httpCtx)).toBe('warn');
    expect(statusOf(weakPage, 'img-alt', httpCtx)).toBe('bad');
  });

  it('flags a noindex directive as not indexable', () => {
    const noindex = strongPage.replace(
      '<meta charset="utf-8">',
      '<meta charset="utf-8"><meta name="robots" content="noindex, nofollow">',
    );
    const report = analyzeSeo(parseHtml(noindex), httpsCtx);
    expect(report.facts.indexable).toBe(false);
    expect(report.checks.find((c) => c.id === 'robots')?.status).toBe('bad');
  });

  it('detects the extended metrics', () => {
    const report = analyzeSeo(parseHtml(strongPage), httpsCtx);
    expect(report.facts.charset).toBe('utf-8');
    expect(report.facts.favicon).toBe(false);
    expect(report.facts.canonicalSelfReferential).toBe(true);
    expect(report.facts.headingDistribution.h1).toBe(1);
    expect(report.facts.headingDistribution.h2).toBe(2);
    expect(report.facts.textToHtmlRatio).toBeGreaterThan(0);
    expect(report.checks.find((c) => c.id === 'twitter-card')?.status).toBe('info');
    expect(report.checks.find((c) => c.id === 'charset')?.status).toBe('good');
  });

  it('flags images that omit width and height', () => {
    const page = `<!doctype html><html lang="en"><head><title>Images here now</title></head>
      <body><h1>x</h1><img src="/a.png" alt="a"><img src="/b.png" alt="b" width="10" height="10"></body></html>`;
    const report = analyzeSeo(parseHtml(page), httpsCtx);
    expect(report.facts.images.missingDimensions).toBe(1);
    expect(report.checks.find((c) => c.id === 'image-dimensions')).toBeDefined();
  });
});

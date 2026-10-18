// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import {
  extract,
  type ImageItem,
  type LinkItem,
  type MetaItem,
  type SelectorItem,
  type TableItem,
} from '../src/lib/analysis/extract';
import { parseHtml, type ResponseContext } from '../src/lib/analysis/html';

const ctx: ResponseContext = {
  finalUrl: 'https://example.com/dir/page',
  status: 200,
  headers: { 'content-type': 'text/html' },
};

const page = `<!doctype html>
<html lang="en">
<head>
  <title>Catalog</title>
  <link rel="canonical" href="https://example.com/dir/page">
  <meta name="description" content="A catalog page">
  <meta property="og:title" content="Catalog">
</head>
<body>
  <a href="/dir/next">Same site</a>
  <a href="other">Relative sibling</a>
  <a href="https://external.test/x">Offsite</a>
  <a href="#section">Fragment only</a>
  <img src="pic.png" alt="A picture" width="40" height="30">
  <img data-src="/lazy.png">
  <h1>Catalog</h1>
  <h2>Fruit</h2>
  <table>
    <thead><tr><th>Name</th><th>Price</th></tr></thead>
    <tbody>
      <tr><td>Apple</td><td>1</td></tr>
      <tr><td>Pear</td><td>2</td></tr>
    </tbody>
  </table>
  <p class="target">first</p>
  <p class="target">second</p>
</body>
</html>`;

describe('extraction', () => {
  const doc = parseHtml(page);

  it('resolves links to absolute URLs and marks external ones', () => {
    const result = extract(doc, ctx, { mode: 'links' });
    const items = result.items as LinkItem[];
    // The fragment-only link is dropped.
    expect(result.count).toBe(3);
    expect(items[0]).toMatchObject({
      href: 'https://example.com/dir/next',
      external: false,
    });
    expect(items[1]?.href).toBe('https://example.com/dir/other');
    expect(items[2]).toMatchObject({
      href: 'https://external.test/x',
      external: true,
    });
  });

  it('extracts images including lazy data-src and reports alt', () => {
    const items = extract(doc, ctx, { mode: 'images' }).items as ImageItem[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      src: 'https://example.com/dir/pic.png',
      alt: 'A picture',
      width: '40',
      height: '30',
    });
    expect(items[1]?.src).toBe('https://example.com/lazy.png');
    expect(items[1]?.alt).toBeNull();
  });

  it('turns a table into headers and rows', () => {
    const items = extract(doc, ctx, { mode: 'tables' }).items as TableItem[];
    expect(items).toHaveLength(1);
    expect(items[0]?.headers).toEqual(['Name', 'Price']);
    expect(items[0]?.rows).toEqual([
      ['Apple', '1'],
      ['Pear', '2'],
    ]);
  });

  it('dumps metadata including title and canonical', () => {
    const items = extract(doc, ctx, { mode: 'meta' }).items as MetaItem[];
    const byKey = Object.fromEntries(items.map((item) => [item.key, item.value]));
    expect(byKey.title).toBe('Catalog');
    expect(byKey.canonical).toBe('https://example.com/dir/page');
    expect(byKey.description).toBe('A catalog page');
    expect(byKey['og:title']).toBe('Catalog');
  });

  it('matches a CSS selector and returns tag, text and attributes', () => {
    const result = extract(doc, ctx, { mode: 'selector', selector: 'p.target' });
    const items = result.items as SelectorItem[];
    expect(result.count).toBe(2);
    expect(items[0]).toMatchObject({ tag: 'p', text: 'first' });
    expect(items[0]?.attributes.class).toBe('target');
  });

  it('reports an invalid selector instead of throwing', () => {
    const result = extract(doc, ctx, { mode: 'selector', selector: ')(' });
    expect(result.error).toBeTruthy();
    expect(result.count).toBe(0);
  });

  it('counts words in text mode', () => {
    const result = extract(doc, ctx, { mode: 'text' });
    expect(result.count).toBeGreaterThan(0);
    expect(typeof (result.items as string[])[0]).toBe('string');
  });
});

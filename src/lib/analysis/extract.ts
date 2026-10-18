/*
 * Structured extraction ("web scraping") over a response the relay already
 * fetched. Each mode turns the parsed page into JSON-serialisable data the UI
 * can render and the user can copy.
 *
 * This operates only on the single page in front of it. It does not crawl, so
 * there is no robots.txt or rate-limit concern beyond the relay's existing
 * per-caller quota; following links would be a different, heavier feature with
 * its own obligations.
 */

import {
  absoluteUrl,
  isSameHost,
  metaMap,
  normalizeText,
  readableText,
  wordCount,
  type ResponseContext,
} from './html';

export type ExtractMode =
  | 'links'
  | 'images'
  | 'headings'
  | 'tables'
  | 'meta'
  | 'text'
  | 'selector';

export type LinkItem = {
  text: string;
  href: string;
  rel: string | null;
  external: boolean;
};
export type ImageItem = {
  src: string;
  alt: string | null;
  width: string | null;
  height: string | null;
};
export type HeadingItem = { level: number; text: string };
export type TableItem = { headers: string[]; rows: string[][] };
export type MetaItem = { key: string; value: string };
export type SelectorItem = {
  tag: string;
  text: string;
  attributes: Record<string, string>;
};

export type ExtractItem =
  | LinkItem
  | ImageItem
  | HeadingItem
  | TableItem
  | MetaItem
  | SelectorItem
  | string;

export type ExtractResult = {
  mode: ExtractMode;
  count: number;
  items: ExtractItem[];
  /** Context about what was or was not returned. */
  note?: string;
  /** Set when a user-supplied selector was invalid. */
  error?: string;
};

export type ExtractOptions = {
  mode: ExtractMode;
  /** CSS selector, used only in 'selector' mode. */
  selector?: string;
};

const MAX_ITEMS = 500;

export function extract(
  doc: Document,
  ctx: ResponseContext,
  options: ExtractOptions,
): ExtractResult {
  switch (options.mode) {
    case 'links':
      return extractLinks(doc, ctx);
    case 'images':
      return extractImages(doc, ctx);
    case 'headings':
      return extractHeadings(doc);
    case 'tables':
      return extractTables(doc);
    case 'meta':
      return extractMeta(doc, ctx);
    case 'text':
      return extractText(doc);
    case 'selector':
      return extractBySelector(doc, options.selector ?? '');
    default:
      return { mode: options.mode, count: 0, items: [] };
  }
}

function capped(items: ExtractItem[], mode: ExtractMode): ExtractResult {
  if (items.length > MAX_ITEMS) {
    return {
      mode,
      count: MAX_ITEMS,
      items: items.slice(0, MAX_ITEMS),
      note: `Showing the first ${MAX_ITEMS} of ${items.length} matches.`,
    };
  }
  return { mode, count: items.length, items };
}

function extractLinks(doc: Document, ctx: ResponseContext): ExtractResult {
  const items: ExtractItem[] = [];
  for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = absoluteUrl(anchor.getAttribute('href'), ctx.finalUrl);
    if (!href) continue;
    items.push({
      text: normalizeText(anchor.textContent),
      href,
      rel: anchor.getAttribute('rel'),
      external: !isSameHost(href, ctx.finalUrl),
    } satisfies LinkItem);
  }
  return capped(items, 'links');
}

function extractImages(doc: Document, ctx: ResponseContext): ExtractResult {
  const items: ExtractItem[] = [];
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = absoluteUrl(
      img.getAttribute('src') ?? img.getAttribute('data-src'),
      ctx.finalUrl,
    );
    if (!src) continue;
    items.push({
      src,
      alt: img.getAttribute('alt'),
      width: img.getAttribute('width'),
      height: img.getAttribute('height'),
    } satisfies ImageItem);
  }
  return capped(items, 'images');
}

function extractHeadings(doc: Document): ExtractResult {
  const items: ExtractItem[] = Array.from(
    doc.querySelectorAll('h1,h2,h3,h4,h5,h6'),
  ).map((node) => ({
    level: Number(node.tagName[1]),
    text: normalizeText(node.textContent),
  }));
  return capped(items, 'headings');
}

function cellText(row: Element, selector: string): string[] {
  return Array.from(row.querySelectorAll(selector)).map((cell) =>
    normalizeText(cell.textContent),
  );
}

function extractTables(doc: Document): ExtractResult {
  const items: ExtractItem[] = [];
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) continue;

    // Header row: an explicit <thead>, or the first row if it is all <th>.
    const headerRow =
      table.querySelector('thead tr') ??
      (rows[0] && cellText(rows[0], 'th').length > 0 ? rows[0] : null);
    const headers = headerRow ? cellText(headerRow, 'th,td') : [];

    const bodyRows = rows
      .filter((row) => row !== headerRow)
      .map((row) => cellText(row, 'td,th'))
      .filter((cells) => cells.length > 0);

    items.push({ headers, rows: bodyRows } satisfies TableItem);
  }
  return capped(items, 'tables');
}

function extractMeta(doc: Document, ctx: ResponseContext): ExtractResult {
  const items: ExtractItem[] = [];
  const title = normalizeText(doc.querySelector('title')?.textContent);
  if (title) items.push({ key: 'title', value: title } satisfies MetaItem);

  const lang = doc.documentElement?.getAttribute('lang');
  if (lang) items.push({ key: 'html:lang', value: lang } satisfies MetaItem);

  const canonical = absoluteUrl(
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    ctx.finalUrl,
  );
  if (canonical) {
    items.push({ key: 'canonical', value: canonical } satisfies MetaItem);
  }

  for (const [key, value] of metaMap(doc)) {
    items.push({ key, value: normalizeText(value) } satisfies MetaItem);
  }
  return capped(items, 'meta');
}

function extractText(doc: Document): ExtractResult {
  const text = readableText(doc);
  return {
    mode: 'text',
    count: wordCount(text),
    items: text === '' ? [] : [text],
    note: `${wordCount(text)} words of readable text.`,
  };
}

function extractBySelector(doc: Document, selector: string): ExtractResult {
  const trimmed = selector.trim();
  if (trimmed === '') {
    return {
      mode: 'selector',
      count: 0,
      items: [],
      note: 'Enter a CSS selector to extract matching elements.',
    };
  }

  let matches: Element[];
  try {
    matches = Array.from(doc.querySelectorAll(trimmed));
  } catch {
    return {
      mode: 'selector',
      count: 0,
      items: [],
      error: `"${trimmed}" is not a valid CSS selector.`,
    };
  }

  const items: ExtractItem[] = matches.map((el) => {
    const attributes: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      attributes[attr.name] = attr.value;
    }
    return {
      tag: el.tagName.toLowerCase(),
      text: normalizeText(el.textContent),
      attributes,
    } satisfies SelectorItem;
  });

  const result = capped(items, 'selector');
  if (result.count === 0 && !result.note) {
    result.note = `No elements matched "${trimmed}".`;
  }
  return result;
}

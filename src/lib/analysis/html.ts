/*
 * Shared HTML-analysis foundation for the SEO, extraction and page-security
 * features.
 *
 * Everything here runs in the BROWSER, on the response body the relay already
 * returned. That is deliberate: the server stays the minimal, guarded pipe the
 * whole project is built around, so none of these features add a new fetch
 * capability or a new way to reach the network. They inherit the SSRF guard,
 * authentication and per-caller quota for free, because the request they
 * analyse already went through `/api/relay`.
 *
 * The parser is the platform's own `DOMParser` with a `text/html` document,
 * which is inert: it does not run scripts and does not fetch sub-resources, so
 * parsing a hostile page cannot execute it. Tests supply the same `DOMParser`
 * through happy-dom, so the analysers run unchanged in Node.
 */

export type ResponseContext = {
  /** The final URL after redirects, used to resolve relative references. */
  finalUrl: string;
  status: number;
  /** Response headers, keys in any case. */
  headers: Record<string, string>;
};

/**
 * Parses an HTML string into an inert Document.
 *
 * Throws when no DOMParser is present rather than silently returning nothing,
 * so a mistaken server-side call surfaces loudly instead of looking like a
 * page with no content.
 */
export function parseHtml(html: string): Document {
  if (typeof DOMParser === 'undefined') {
    throw new Error(
      'HTML analysis runs in the browser; no DOMParser is available in this environment.',
    );
  }
  return new DOMParser().parseFromString(html, 'text/html');
}

/** True when the response declared itself HTML. */
export function isHtmlResponse(headers: Record<string, string>): boolean {
  return lowerHeaders(headers)['content-type']?.includes('html') ?? false;
}

/** Lower-cases header names so lookups do not depend on the server's casing. */
export function lowerHeaders(
  input: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

/**
 * Resolves a possibly-relative reference against the final response URL.
 * Returns null for empty, fragment-only, or unparseable references, and for
 * non-navigational schemes callers usually want to skip.
 */
export function absoluteUrl(
  href: string | null | undefined,
  base: string,
): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  if (/^(?:javascript|mailto|tel|data):/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

/** Whether a resolved URL points at the same registrable host as the base. */
export function isSameHost(resolved: string, base: string): boolean {
  try {
    return new URL(resolved).host === new URL(base).host;
  } catch {
    return false;
  }
}

/** Collapses runs of whitespace to single spaces and trims. */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * A map of every meta tag's name/property (lower-cased) to its content, plus
 * the document title and <html lang>. One pass, shared by SEO and extraction.
 */
export function metaMap(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  for (const meta of Array.from(doc.querySelectorAll('meta'))) {
    const key = (
      meta.getAttribute('name') ??
      meta.getAttribute('property') ??
      meta.getAttribute('http-equiv') ??
      ''
    )
      .trim()
      .toLowerCase();
    if (key === '') continue;
    const content = meta.getAttribute('content');
    if (content === null) continue;
    // First declaration wins, matching how crawlers treat duplicates.
    if (!map.has(key)) map.set(key, content);
  }
  return map;
}

/** Visible text with script, style and template content removed. */
export function readableText(doc: Document): string {
  const body = doc.body;
  if (!body) return '';
  const clone = body.cloneNode(true) as HTMLElement;
  for (const node of Array.from(
    clone.querySelectorAll('script, style, noscript, template'),
  )) {
    node.remove();
  }
  return normalizeText(clone.textContent);
}

/** Word count of the readable text, for thin-content judgement. */
export function wordCount(text: string): number {
  if (text.trim() === '') return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

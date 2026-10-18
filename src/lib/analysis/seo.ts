/*
 * SEO detection and judgement.
 *
 * "Detection" reads the SEO-relevant facts out of the page; "judgement" grades
 * each one against widely-published guidance (title and description lengths,
 * a single h1, mobile viewport, alt-text coverage, Open Graph completeness,
 * indexability, structured data) and rolls the result into a score and a
 * letter grade.
 *
 * The thresholds are conventional rather than secret: a title reads well at
 * roughly 30-60 characters, a meta description at roughly 50-160, and so on.
 * Each check explains itself so the grade is transparent, not an oracle.
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

export type SeoStatus = 'good' | 'warn' | 'bad' | 'info';

export type SeoCheck = {
  id: string;
  label: string;
  status: SeoStatus;
  detail: string;
  /** What to change, when the status is not good. */
  recommendation?: string;
};

export type SeoFacts = {
  title: string | null;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  canonical: string | null;
  canonicalSelfReferential: boolean | null;
  lang: string | null;
  charset: string | null;
  favicon: boolean;
  h1: readonly string[];
  headingCount: number;
  headingDistribution: Record<'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', number>;
  images: { total: number; missingAlt: number; missingDimensions: number };
  words: number;
  textToHtmlRatio: number;
  links: { internal: number; external: number; nofollow: number };
  openGraph: readonly string[];
  twitterCard: readonly string[];
  structuredDataTypes: readonly string[];
  indexable: boolean;
};

export type SeoReport = {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  checks: readonly SeoCheck[];
  facts: SeoFacts;
};

const PENALTY: Record<SeoStatus, number> = { good: 0, info: 0, warn: 6, bad: 15 };

function grade(score: number): SeoReport['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

export function analyzeSeo(doc: Document, ctx: ResponseContext): SeoReport {
  const checks: SeoCheck[] = [];
  const add = (check: SeoCheck) => checks.push(check);
  const meta = metaMap(doc);

  // --- Title ---
  const title = normalizeText(doc.querySelector('title')?.textContent) || null;
  const titleLength = title?.length ?? 0;
  if (!title) {
    add({
      id: 'title',
      label: 'Title tag',
      status: 'bad',
      detail: 'The page has no <title>.',
      recommendation: 'Add a unique, descriptive title of about 30-60 characters.',
    });
  } else if (titleLength < 15 || titleLength > 65) {
    add({
      id: 'title',
      label: 'Title tag',
      status: 'warn',
      detail: `Title is ${titleLength} characters: "${title}".`,
      recommendation:
        titleLength < 15
          ? 'Expand the title toward 30-60 characters so it describes the page.'
          : 'Shorten the title toward 60 characters so search engines do not truncate it.',
    });
  } else {
    add({
      id: 'title',
      label: 'Title tag',
      status: 'good',
      detail: `Title is ${titleLength} characters: "${title}".`,
    });
  }

  // --- Meta description ---
  const description = normalizeText(meta.get('description')) || null;
  const descriptionLength = description?.length ?? 0;
  if (!description) {
    add({
      id: 'description',
      label: 'Meta description',
      status: 'bad',
      detail: 'No meta description was found.',
      recommendation: 'Add a meta description of about 50-160 characters summarising the page.',
    });
  } else if (descriptionLength < 50 || descriptionLength > 160) {
    add({
      id: 'description',
      label: 'Meta description',
      status: 'warn',
      detail: `Description is ${descriptionLength} characters.`,
      recommendation:
        descriptionLength < 50
          ? 'Lengthen it toward 150 characters to use the available snippet.'
          : 'Trim it toward 160 characters so it is not cut off in results.',
    });
  } else {
    add({
      id: 'description',
      label: 'Meta description',
      status: 'good',
      detail: `Description is ${descriptionLength} characters.`,
    });
  }

  // --- Canonical ---
  const canonicalHref = doc
    .querySelector('link[rel="canonical"]')
    ?.getAttribute('href');
  const canonical = absoluteUrl(canonicalHref, ctx.finalUrl);
  if (!canonical) {
    add({
      id: 'canonical',
      label: 'Canonical URL',
      status: 'info',
      detail: 'No canonical link is declared.',
      recommendation: 'Add <link rel="canonical"> if this content is reachable at more than one URL.',
    });
  } else {
    add({
      id: 'canonical',
      label: 'Canonical URL',
      status: 'good',
      detail: `Canonical points at ${canonical}.`,
    });
  }

  // --- Indexability (robots meta) ---
  const robots = (meta.get('robots') ?? '').toLowerCase();
  const indexable = !robots.includes('noindex');
  if (robots.includes('noindex')) {
    add({
      id: 'robots',
      label: 'Indexability',
      status: 'bad',
      detail: `A robots meta tag requests noindex: "${robots}".`,
      recommendation: 'Remove noindex if this page is meant to appear in search results.',
    });
  } else if (robots.includes('nofollow')) {
    add({
      id: 'robots',
      label: 'Indexability',
      status: 'warn',
      detail: 'Links on the page are marked nofollow by a robots meta tag.',
      recommendation: 'Confirm that suppressing link equity from this page is intended.',
    });
  } else {
    add({
      id: 'robots',
      label: 'Indexability',
      status: 'good',
      detail: 'No robots meta tag blocks indexing.',
    });
  }

  // --- Mobile viewport ---
  if (meta.has('viewport')) {
    add({
      id: 'viewport',
      label: 'Mobile viewport',
      status: 'good',
      detail: `Viewport is set: "${normalizeText(meta.get('viewport'))}".`,
    });
  } else {
    add({
      id: 'viewport',
      label: 'Mobile viewport',
      status: 'bad',
      detail: 'No viewport meta tag, so mobile browsers assume a desktop width.',
      recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    });
  }

  // --- Language ---
  const lang = normalizeText(doc.documentElement?.getAttribute('lang')) || null;
  add(
    lang
      ? {
          id: 'lang',
          label: 'Language',
          status: 'good',
          detail: `Document language is "${lang}".`,
        }
      : {
          id: 'lang',
          label: 'Language',
          status: 'warn',
          detail: 'The <html> element has no lang attribute.',
          recommendation: 'Set <html lang="…"> to help search engines and screen readers.',
        },
  );

  // --- H1 ---
  const h1s = Array.from(doc.querySelectorAll('h1'))
    .map((node) => normalizeText(node.textContent))
    .filter(Boolean);
  if (h1s.length === 0) {
    add({
      id: 'h1',
      label: 'H1 heading',
      status: 'bad',
      detail: 'The page has no H1 heading.',
      recommendation: 'Add a single H1 that states the main topic of the page.',
    });
  } else if (h1s.length > 1) {
    add({
      id: 'h1',
      label: 'H1 heading',
      status: 'warn',
      detail: `The page has ${h1s.length} H1 headings.`,
      recommendation: 'Prefer a single H1 so the primary topic is unambiguous.',
    });
  } else {
    add({
      id: 'h1',
      label: 'H1 heading',
      status: 'good',
      detail: `One H1: "${h1s[0]}".`,
    });
  }

  // --- Heading order ---
  const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  const levels = headings.map((node) => Number(node.tagName[1]));
  let skipped = false;
  for (let i = 1; i < levels.length; i += 1) {
    const current = levels[i];
    const previous = levels[i - 1];
    if (current !== undefined && previous !== undefined && current > previous + 1) {
      skipped = true;
      break;
    }
  }
  if (headings.length === 0) {
    add({
      id: 'headings',
      label: 'Heading structure',
      status: 'warn',
      detail: 'No headings were found.',
      recommendation: 'Use headings to give the content a scannable outline.',
    });
  } else {
    add(
      skipped
        ? {
            id: 'headings',
            label: 'Heading structure',
            status: 'warn',
            detail: 'The heading order skips a level (for example H2 to H4).',
            recommendation: 'Keep headings sequential so the outline is coherent.',
          }
        : {
            id: 'headings',
            label: 'Heading structure',
            status: 'good',
            detail: `${headings.length} headings in a sequential outline.`,
          },
    );
  }

  // --- Image alt coverage ---
  const images = Array.from(doc.querySelectorAll('img'));
  const missingAlt = images.filter(
    (img) => normalizeText(img.getAttribute('alt')) === '' && img.getAttribute('alt') === null,
  ).length;
  if (images.length === 0) {
    add({
      id: 'img-alt',
      label: 'Image alt text',
      status: 'info',
      detail: 'No images on the page.',
    });
  } else {
    const coverage = Math.round(((images.length - missingAlt) / images.length) * 100);
    add(
      missingAlt === 0
        ? {
            id: 'img-alt',
            label: 'Image alt text',
            status: 'good',
            detail: `All ${images.length} images have an alt attribute.`,
          }
        : {
            id: 'img-alt',
            label: 'Image alt text',
            status: coverage < 50 ? 'bad' : 'warn',
            detail: `${missingAlt} of ${images.length} images have no alt attribute (${coverage}% covered).`,
            recommendation: 'Add descriptive alt text; use alt="" only for decorative images.',
          },
    );
  }

  // --- Open Graph ---
  const ogPresent = ['og:title', 'og:description', 'og:image'].filter((key) =>
    meta.has(key),
  );
  if (ogPresent.length === 0) {
    add({
      id: 'open-graph',
      label: 'Open Graph',
      status: 'warn',
      detail: 'No Open Graph tags, so shared links lack a controlled preview.',
      recommendation: 'Add og:title, og:description and og:image for rich social previews.',
    });
  } else if (ogPresent.length < 3) {
    add({
      id: 'open-graph',
      label: 'Open Graph',
      status: 'warn',
      detail: `Partial Open Graph: ${ogPresent.join(', ')}.`,
      recommendation: 'Add the remaining og:title, og:description or og:image tags.',
    });
  } else {
    add({
      id: 'open-graph',
      label: 'Open Graph',
      status: 'good',
      detail: 'og:title, og:description and og:image are all present.',
    });
  }

  // --- Twitter Card ---
  const twitterCard = [
    'twitter:card',
    'twitter:title',
    'twitter:description',
    'twitter:image',
  ].filter((key) => meta.has(key));
  // Informational, not penalising: Twitter falls back to Open Graph and the
  // tags are not a ranking signal, so their absence is noted, not marked down.
  add(
    meta.has('twitter:card')
      ? {
          id: 'twitter-card',
          label: 'Twitter Card',
          status: 'good',
          detail: `Twitter Card present (${twitterCard.join(', ')}).`,
        }
      : {
          id: 'twitter-card',
          label: 'Twitter Card',
          status: 'info',
          detail: 'No twitter:card tag; X/Twitter will fall back to Open Graph.',
          recommendation: 'Add twitter:card (and title/description/image) for a tailored preview.',
        },
  );

  // --- Structured data (JSON-LD) ---
  const ldNodes = Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  );
  const structuredDataTypes: string[] = [];
  let invalidLd = false;
  for (const node of ldNodes) {
    try {
      const parsed = JSON.parse(node.textContent ?? '');
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const type = entry?.['@type'];
        if (typeof type === 'string') structuredDataTypes.push(type);
        else if (Array.isArray(type)) structuredDataTypes.push(...type.filter((t) => typeof t === 'string'));
      }
    } catch {
      invalidLd = true;
    }
  }
  if (ldNodes.length === 0) {
    add({
      id: 'structured-data',
      label: 'Structured data',
      status: 'info',
      detail: 'No JSON-LD structured data found.',
      recommendation: 'Consider schema.org JSON-LD so engines can show rich results.',
    });
  } else if (invalidLd) {
    add({
      id: 'structured-data',
      label: 'Structured data',
      status: 'warn',
      detail: 'A JSON-LD block is present but did not parse as valid JSON.',
      recommendation: 'Fix the JSON-LD syntax so crawlers can read it.',
    });
  } else {
    add({
      id: 'structured-data',
      label: 'Structured data',
      status: 'good',
      detail: `JSON-LD present: ${[...new Set(structuredDataTypes)].join(', ') || 'untyped'}.`,
    });
  }

  // --- HTTPS ---
  const isHttps = ctx.finalUrl.startsWith('https://');
  add(
    isHttps
      ? {
          id: 'https',
          label: 'HTTPS',
          status: 'good',
          detail: 'The final URL is served over HTTPS.',
        }
      : {
          id: 'https',
          label: 'HTTPS',
          status: 'bad',
          detail: 'The page is served over plain HTTP.',
          recommendation: 'Serve the page over HTTPS; it is a ranking signal and a security baseline.',
        },
  );

  // --- Content depth ---
  const words = wordCount(readableText(doc));
  add(
    words >= 200
      ? {
          id: 'content',
          label: 'Content depth',
          status: 'good',
          detail: `About ${words} words of readable text.`,
        }
      : {
          id: 'content',
          label: 'Content depth',
          status: 'warn',
          detail: `Only about ${words} words of readable text.`,
          recommendation: 'Thin pages are harder to rank; add substantive content where appropriate.',
        },
  );

  // --- Character encoding ---
  const charsetMeta =
    doc.querySelector('meta[charset]')?.getAttribute('charset') ??
    (/charset=([\w-]+)/i.exec(meta.get('content-type') ?? '')?.[1] ?? null);
  const charset = charsetMeta ? charsetMeta.trim() : null;
  add(
    charset
      ? {
          id: 'charset',
          label: 'Character encoding',
          status: 'good',
          detail: `Declared charset is ${charset}.`,
        }
      : {
          id: 'charset',
          label: 'Character encoding',
          status: 'warn',
          detail: 'No character encoding is declared.',
          recommendation: 'Add <meta charset="utf-8"> as the first element in <head>.',
        },
  );

  // --- Favicon ---
  const favicon = Boolean(doc.querySelector('link[rel~="icon" i]'));
  add({
    id: 'favicon',
    label: 'Favicon',
    status: favicon ? 'good' : 'info',
    detail: favicon ? 'A favicon link is declared.' : 'No favicon link element found.',
    ...(favicon ? {} : { recommendation: 'Add <link rel="icon"> so results and tabs show an icon.' }),
  });

  // --- Canonical self-reference (informational) ---
  let canonicalSelfReferential: boolean | null = null;
  if (canonical) {
    const strip = (value: string) => value.replace(/\/$/, '');
    canonicalSelfReferential = strip(canonical) === strip(ctx.finalUrl);
    if (!canonicalSelfReferential) {
      add({
        id: 'canonical-self',
        label: 'Canonical target',
        status: 'info',
        detail: `Canonical points to a different URL than the one fetched (${canonical}).`,
        recommendation: 'Confirm this page should defer to another URL for indexing.',
      });
    }
  }

  // --- Image dimensions (layout stability) ---
  const missingDimensions = images.filter(
    (img) => !img.getAttribute('width') || !img.getAttribute('height'),
  ).length;
  if (images.length > 0) {
    const ratioMissing = missingDimensions / images.length;
    add(
      missingDimensions === 0
        ? {
            id: 'image-dimensions',
            label: 'Image dimensions',
            status: 'good',
            detail: 'All images declare width and height.',
          }
        : {
            id: 'image-dimensions',
            label: 'Image dimensions',
            status: ratioMissing > 0.25 ? 'warn' : 'info',
            detail: `${missingDimensions} of ${images.length} images omit width/height, risking layout shift (CLS).`,
            recommendation: 'Set width and height (or aspect-ratio) on images to reserve space.',
          },
    );
  }

  // --- Link profile (reported, not graded) ---
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  for (const anchor of anchors) {
    if ((anchor.getAttribute('rel') ?? '').toLowerCase().includes('nofollow')) {
      nofollow += 1;
    }
    const resolved = absoluteUrl(anchor.getAttribute('href'), ctx.finalUrl);
    if (!resolved) continue;
    if (isSameHost(resolved, ctx.finalUrl)) internal += 1;
    else external += 1;
  }
  add({
    id: 'links',
    label: 'Links',
    status: 'info',
    detail: `${internal} internal, ${external} external${nofollow > 0 ? `, ${nofollow} nofollow` : ''} links.`,
  });

  // --- Heading distribution and text-to-HTML ratio (metrics) ---
  const headingDistribution = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  for (const level of levels) {
    const key = `h${level}` as keyof typeof headingDistribution;
    if (key in headingDistribution) headingDistribution[key] += 1;
  }
  const readable = readableText(doc);
  const htmlLength = doc.documentElement?.outerHTML.length ?? 0;
  const textToHtmlRatio =
    htmlLength > 0 ? Math.round((readable.length / htmlLength) * 1000) / 10 : 0;

  const score = Math.max(
    0,
    Math.min(
      100,
      100 - checks.reduce((total, check) => total + PENALTY[check.status], 0),
    ),
  );

  const facts: SeoFacts = {
    title,
    titleLength,
    description,
    descriptionLength,
    canonical,
    canonicalSelfReferential,
    lang,
    charset,
    favicon,
    h1: h1s,
    headingCount: headings.length,
    headingDistribution,
    images: { total: images.length, missingAlt, missingDimensions },
    words,
    textToHtmlRatio,
    links: { internal, external, nofollow },
    openGraph: ogPresent,
    twitterCard,
    structuredDataTypes: [...new Set(structuredDataTypes)],
    indexable,
  };

  return { score, grade: grade(score), checks, facts };
}

import { describe, expect, it } from 'vitest';

import {
  buildFullReport,
  buildSecurityReport,
  buildSeoReport,
  categoryFor,
  escapeCsvCell,
  fullReportToCsv,
  reportFilenameBase,
  securityReportToCsv,
  seoReportToCsv,
  toCsv,
} from '../src/lib/analysis/report';
import type { SeoReport } from '../src/lib/analysis/seo';
import type { SecurityFinding } from '../src/lib/testing/security';

const seoReport: SeoReport = {
  score: 82,
  grade: 'B',
  checks: [
    { id: 'title', label: 'Title tag', status: 'good', detail: 'Fine.' },
    {
      id: 'description',
      label: 'Meta description',
      status: 'bad',
      detail: 'Missing.',
      recommendation: 'Add one.',
    },
    { id: 'links', label: 'Links', status: 'info', detail: '3 internal.' },
  ],
  facts: {
    title: 'Hello',
    titleLength: 5,
    description: null,
    descriptionLength: 0,
    canonical: null,
    canonicalSelfReferential: null,
    lang: 'en',
    charset: 'utf-8',
    favicon: true,
    h1: ['Hello'],
    headingCount: 1,
    headingDistribution: { h1: 1, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    images: { total: 2, missingAlt: 1, missingDimensions: 0 },
    words: 120,
    textToHtmlRatio: 12.5,
    links: { internal: 3, external: 1, nofollow: 0 },
    openGraph: ['og:title'],
    twitterCard: [],
    structuredDataTypes: [],
    indexable: true,
  },
};

const findings: SecurityFinding[] = [
  { id: 'csp', title: 'CSP present', severity: 'pass', detail: 'ok' },
  { id: 'hsts', title: 'HSTS missing', severity: 'medium', detail: 'add it' },
  {
    id: 'mixed-content',
    title: 'Mixed content',
    severity: 'high',
    detail: 'http resource',
  },
];

const fixedDate = new Date('2026-10-15T15:30:45.000Z');

describe('CSV serialisation', () => {
  it('quotes cells containing commas, quotes or newlines', () => {
    expect(escapeCsvCell('plain')).toBe('plain');
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection', () => {
    // A leading =, +, -, @ is prefixed so a spreadsheet treats it as text.
    expect(escapeCsvCell('=1+2')).toBe("'=1+2");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell('-5')).toBe("'-5");
    expect(escapeCsvCell('+1')).toBe("'+1");
  });

  it('writes a header line and CRLF-separated rows', () => {
    const csv = toCsv(
      [
        { key: 'a', header: 'A' },
        { key: 'b', header: 'B' },
      ],
      [
        { a: '1', b: '2' },
        { a: '3', b: '4' },
      ],
    );
    expect(csv).toBe('A,B\r\n1,2\r\n3,4');
  });
});

describe('report builders', () => {
  it('summarises SEO checks by status and keeps metrics', () => {
    const doc = buildSeoReport(seoReport, 'https://example.com/page', fixedDate);
    expect(doc.kind).toBe('seo');
    expect(doc.target).toBe('https://example.com/page');
    expect(doc.generatedAt).toBe('2026-10-15T15:30:45.000Z');
    expect(doc.summary).toEqual({ good: 1, bad: 1, info: 1, warn: 0 });
    expect(doc.metrics.textToHtmlRatio).toBe(12.5);
    expect(doc.checks).toHaveLength(3);
  });

  it('categorises security findings and counts severities', () => {
    const doc = buildSecurityReport(findings, 68, 'https://example.com', fixedDate);
    expect(doc.summary).toEqual({ pass: 1, info: 0, low: 0, medium: 1, high: 1 });
    expect(doc.score).toBe(68);
    const mixed = doc.findings.find((f) => f.id === 'mixed-content');
    expect(mixed?.category).toBe('content');
    expect(doc.findings.find((f) => f.id === 'hsts')?.category).toBe('transport');
  });

  it('maps unknown finding ids to "other"', () => {
    expect(categoryFor('nosniff')).toBe('headers');
    expect(categoryFor('made-up-id')).toBe('other');
  });
});

describe('CSV exports', () => {
  it('emits an SEO checks table with a recommendation column', () => {
    const csv = seoReportToCsv(buildSeoReport(seoReport, 'https://example.com', fixedDate));
    const [header, ...rows] = csv.split('\r\n');
    expect(header).toBe('ID,Check,Status,Detail,Recommendation');
    expect(rows).toHaveLength(3);
    expect(csv).toContain('description,Meta description,bad,Missing.,Add one.');
  });

  it('emits a security findings table with category and severity', () => {
    const csv = securityReportToCsv(
      buildSecurityReport(findings, 68, 'https://example.com', fixedDate),
    );
    expect(csv.split('\r\n')[0]).toBe('ID,Category,Severity,Finding,Detail');
    expect(csv).toContain('mixed-content,content,high,Mixed content,http resource');
  });
});

describe('combined full report', () => {
  const extraction = { links: 27, images: 4, headings: 6, tables: 1, metadata: 9 };

  it('composes SEO, extraction and security with a headline overview', () => {
    const doc = buildFullReport(
      { target: 'https://example.com', seo: seoReport, extraction, securityFindings: findings, securityScore: 68 },
      fixedDate,
    );
    expect(doc.kind).toBe('full');
    expect(doc.overview).toEqual({
      isHtml: true,
      seoScore: 82,
      seoGrade: 'B',
      securityScore: 68,
      findingCounts: { pass: 1, info: 0, low: 0, medium: 1, high: 1 },
    });
    expect(doc.seo?.summary).toEqual({ good: 1, bad: 1, info: 1, warn: 0 });
    expect(doc.extraction).toEqual(extraction);
    expect(doc.security.findings.find((f) => f.id === 'mixed-content')?.category).toBe('content');
  });

  it('nulls the SEO and extraction sections for a non-HTML response', () => {
    const doc = buildFullReport(
      { target: 'https://api.example.com', seo: null, extraction: null, securityFindings: findings, securityScore: 90 },
      fixedDate,
    );
    expect(doc.seo).toBeNull();
    expect(doc.extraction).toBeNull();
    expect(doc.overview.isHtml).toBe(false);
    expect(doc.overview.seoScore).toBeNull();
  });

  it('flattens every section into one CSV keyed by section', () => {
    const doc = buildFullReport(
      { target: 'https://example.com', seo: seoReport, extraction, securityFindings: findings, securityScore: 68 },
      fixedDate,
    );
    const csv = fullReportToCsv(doc);
    expect(csv.split('\r\n')[0]).toBe('Section,ID,Item,Level,Detail');
    expect(csv).toContain('security,mixed-content,Mixed content,high,');
    expect(csv).toContain('seo,description,Meta description,bad,');
    expect(csv).toContain('extraction,links,links,info,27');
  });
});

describe('report filenames', () => {
  it('builds a safe, descriptive base name', () => {
    expect(reportFilenameBase('seo', 'https://sub.example.com/path', fixedDate)).toBe(
      'relay-seo-sub.example.com-2026-10-15-15-30',
    );
  });

  it('falls back when the target is not a URL', () => {
    expect(reportFilenameBase('security', 'not a url', fixedDate)).toBe(
      'relay-security-report-2026-10-15-15-30',
    );
  });
});

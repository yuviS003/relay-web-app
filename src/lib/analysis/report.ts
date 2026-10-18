/*
 * Report structuring and export for the SEO and security analysers.
 *
 * Two concerns live here:
 *   1. A stable, documented shape for each report (an envelope with tool,
 *      target and timestamp, a summary, and the detailed rows), so an exported
 *      file is self-describing rather than a loose dump of the UI state.
 *   2. Serialisation to JSON and CSV, plus a browser download trigger.
 *
 * The CSV writer defends against spreadsheet formula injection: a cell that
 * begins with =, +, -, @ (or a control character) is prefixed so a program
 * cannot execute it when the file is opened. Report detail text is attacker-
 * influenced — it quotes what a scanned page returned — so this matters.
 */

import type { SecurityFinding, SecuritySeverity } from '@/lib/testing/security';

import type { SeoCheck, SeoFacts, SeoReport } from './seo';

const TOOL = 'relay-web-api-client';

export type ReportKind = 'seo' | 'security' | 'full';

export type SeoReportDocument = {
  tool: typeof TOOL;
  kind: 'seo';
  target: string;
  generatedAt: string;
  score: number;
  grade: string;
  summary: {
    good: number;
    warn: number;
    bad: number;
    info: number;
  };
  metrics: SeoFacts;
  checks: readonly SeoCheck[];
};

export type CategorizedFinding = SecurityFinding & { category: string };

export type SecurityReportDocument = {
  tool: typeof TOOL;
  kind: 'security';
  target: string;
  generatedAt: string;
  score: number;
  summary: Record<SecuritySeverity, number>;
  findings: readonly CategorizedFinding[];
};

/** Counts from a single-page extraction pass, for the combined report. */
export type ExtractionSummary = {
  links: number;
  images: number;
  headings: number;
  tables: number;
  metadata: number;
};

/**
 * The combined, one-click report: SEO grade, extraction summary and the full
 * security audit under one envelope, with an overview that fronts the headline
 * numbers. The SEO and extraction sections are null for a non-HTML response;
 * the security section always runs because it reads headers.
 */
export type FullReportDocument = {
  tool: typeof TOOL;
  kind: 'full';
  target: string;
  generatedAt: string;
  overview: {
    isHtml: boolean;
    seoScore: number | null;
    seoGrade: string | null;
    securityScore: number;
    findingCounts: Record<SecuritySeverity, number>;
  };
  seo: {
    score: number;
    grade: string;
    summary: { good: number; warn: number; bad: number; info: number };
    checks: readonly SeoCheck[];
  } | null;
  extraction: ExtractionSummary | null;
  security: {
    score: number;
    summary: Record<SecuritySeverity, number>;
    findings: readonly CategorizedFinding[];
  };
};

/** Groups a finding id into a section, for a structured report. */
const SECURITY_CATEGORY: Record<string, string> = {
  nosniff: 'headers',
  csp: 'headers',
  'csp-quality': 'headers',
  frame: 'headers',
  referrer: 'headers',
  'permissions-policy': 'headers',
  coop: 'headers',
  corp: 'headers',
  hsts: 'transport',
  'hsts-depth': 'transport',
  'server-disclosure': 'disclosure',
  'secret-pattern': 'disclosure',
  'cookie-http-only': 'cookies',
  'cookie-secure': 'cookies',
  'cookie-samesite': 'cookies',
  'cookie-samesite-none': 'cookies',
  cors: 'cors',
  'cors-reflection': 'cors',
  'cors-wildcard': 'cors',
  'cors-specific': 'cors',
  'cors-probe': 'cors',
  methods: 'methods',
  'methods-trace': 'methods',
  'methods-write': 'methods',
  'mixed-content': 'content',
  tabnabbing: 'content',
  'password-plaintext': 'content',
  'third-party-scripts': 'content',
  'sri-missing': 'content',
  'inline-handlers': 'content',
  'meta-refresh': 'content',
};

export function categoryFor(id: string): string {
  return SECURITY_CATEGORY[id] ?? 'other';
}

export function buildSeoReport(
  report: SeoReport,
  target: string,
  now: Date = new Date(),
): SeoReportDocument {
  const summary = { good: 0, warn: 0, bad: 0, info: 0 };
  for (const check of report.checks) summary[check.status] += 1;
  return {
    tool: TOOL,
    kind: 'seo',
    target,
    generatedAt: now.toISOString(),
    score: report.score,
    grade: report.grade,
    summary,
    metrics: report.facts,
    checks: report.checks,
  };
}

export function buildSecurityReport(
  findings: readonly SecurityFinding[],
  score: number,
  target: string,
  now: Date = new Date(),
): SecurityReportDocument {
  const summary: Record<SecuritySeverity, number> = {
    pass: 0,
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
  };
  for (const finding of findings) summary[finding.severity] += 1;
  return {
    tool: TOOL,
    kind: 'security',
    target,
    generatedAt: now.toISOString(),
    score,
    summary,
    findings: findings.map((finding) => ({
      ...finding,
      category: categoryFor(finding.id),
    })),
  };
}

export function buildFullReport(
  input: {
    target: string;
    seo: SeoReport | null;
    extraction: ExtractionSummary | null;
    securityFindings: readonly SecurityFinding[];
    securityScore: number;
  },
  now: Date = new Date(),
): FullReportDocument {
  const securitySummary: Record<SecuritySeverity, number> = {
    pass: 0,
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
  };
  for (const finding of input.securityFindings) {
    securitySummary[finding.severity] += 1;
  }
  const findings = input.securityFindings.map((finding) => ({
    ...finding,
    category: categoryFor(finding.id),
  }));

  let seoSection: FullReportDocument['seo'] = null;
  if (input.seo) {
    const seoSummary = { good: 0, warn: 0, bad: 0, info: 0 };
    for (const check of input.seo.checks) seoSummary[check.status] += 1;
    seoSection = {
      score: input.seo.score,
      grade: input.seo.grade,
      summary: seoSummary,
      checks: input.seo.checks,
    };
  }

  return {
    tool: TOOL,
    kind: 'full',
    target: input.target,
    generatedAt: now.toISOString(),
    overview: {
      isHtml: input.seo !== null,
      seoScore: input.seo?.score ?? null,
      seoGrade: input.seo?.grade ?? null,
      securityScore: input.securityScore,
      findingCounts: securitySummary,
    },
    seo: seoSection,
    extraction: input.extraction,
    security: { score: input.securityScore, summary: securitySummary, findings },
  };
}

export type CsvColumn = { key: string; header: string };

/**
 * Escapes one CSV cell. Quotes a cell containing a comma, quote or newline,
 * and neutralises a leading formula character so a spreadsheet treats the
 * value as text rather than executing it.
 */
export function escapeCsvCell(value: unknown): string {
  let cell = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  if (/[",\r\n]/.test(cell)) cell = `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

/** Serialises rows to CSV with a header line and CRLF endings (RFC 4180). */
export function toCsv(
  columns: readonly CsvColumn[],
  rows: readonly Record<string, unknown>[],
): string {
  const header = columns.map((column) => escapeCsvCell(column.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((column) => escapeCsvCell(row[column.key])).join(','),
  );
  return [header, ...lines].join('\r\n');
}

export function seoReportToCsv(doc: SeoReportDocument): string {
  return toCsv(
    [
      { key: 'id', header: 'ID' },
      { key: 'label', header: 'Check' },
      { key: 'status', header: 'Status' },
      { key: 'detail', header: 'Detail' },
      { key: 'recommendation', header: 'Recommendation' },
    ],
    doc.checks.map((check) => ({
      id: check.id,
      label: check.label,
      status: check.status,
      detail: check.detail,
      recommendation: check.recommendation ?? '',
    })),
  );
}

export function securityReportToCsv(doc: SecurityReportDocument): string {
  return toCsv(
    [
      { key: 'id', header: 'ID' },
      { key: 'category', header: 'Category' },
      { key: 'severity', header: 'Severity' },
      { key: 'title', header: 'Finding' },
      { key: 'detail', header: 'Detail' },
    ],
    doc.findings.map((finding) => ({
      id: finding.id,
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
    })),
  );
}

/** Flattens the combined report into one tabular export keyed by section. */
export function fullReportToCsv(doc: FullReportDocument): string {
  const rows: Record<string, unknown>[] = [];
  for (const finding of doc.security.findings) {
    rows.push({
      section: 'security',
      id: finding.id,
      item: finding.title,
      level: finding.severity,
      detail: finding.detail,
    });
  }
  if (doc.seo) {
    for (const check of doc.seo.checks) {
      rows.push({
        section: 'seo',
        id: check.id,
        item: check.label,
        level: check.status,
        detail: check.recommendation
          ? `${check.detail} — ${check.recommendation}`
          : check.detail,
      });
    }
  }
  if (doc.extraction) {
    for (const [key, value] of Object.entries(doc.extraction)) {
      rows.push({
        section: 'extraction',
        id: key,
        item: key,
        level: 'info',
        detail: String(value),
      });
    }
  }
  return toCsv(
    [
      { key: 'section', header: 'Section' },
      { key: 'id', header: 'ID' },
      { key: 'item', header: 'Item' },
      { key: 'level', header: 'Level' },
      { key: 'detail', header: 'Detail' },
    ],
    rows,
  );
}

/** A safe, descriptive filename base: `relay-<kind>-<host>-<timestamp>`. */
export function reportFilenameBase(
  kind: ReportKind,
  target: string,
  now: Date = new Date(),
): string {
  let host = 'report';
  try {
    host = new URL(target).host.replace(/[^a-z0-9.-]/gi, '-') || 'report';
  } catch {
    // Target was not a URL; keep the default.
  }
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `relay-${kind}-${host}-${stamp}`;
}

/** Triggers a browser download of text content. Browser-only. */
export function downloadText(
  filename: string,
  mime: string,
  text: string,
): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Downloads require a browser environment.');
  }
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

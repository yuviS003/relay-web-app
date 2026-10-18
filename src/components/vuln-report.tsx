'use client';

import { useState } from 'react';

import { ReportActions } from '@/components/report-actions';
import type { ExecuteRequest } from '@/components/testing-lab';
import { extract } from '@/lib/analysis/extract';
import { isHtmlResponse, parseHtml, type ResponseContext } from '@/lib/analysis/html';
import { auditPageBody } from '@/lib/analysis/page-security';
import {
  buildFullReport,
  type ExtractionSummary,
  type FullReportDocument,
} from '@/lib/analysis/report';
import { analyzeSeo, type SeoStatus } from '@/lib/analysis/seo';
import {
  auditCors,
  auditMethods,
  auditResponse,
  type SecurityFinding,
  securityScore,
} from '@/lib/testing/security';

/** SEO statuses reuse the finding-list severity colours. */
const SEO_SEVERITY: Record<SeoStatus, string> = {
  good: 'pass',
  info: 'info',
  warn: 'medium',
  bad: 'high',
};

export function VulnReport({
  url,
  execute,
}: {
  url: string;
  execute: ExecuteRequest;
}) {
  const [authorized, setAuthorized] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<FullReportDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!authorized) {
      setError('Confirm that you own or are authorized to test this target.');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setError('Enter a complete HTTP or HTTPS URL first.');
      return;
    }

    setRunning(true);
    setError(null);
    setReport(null);

    try {
      // One baseline request feeds every analyser.
      const baseline = await execute();
      if (!baseline.ok || baseline.status === undefined) {
        throw new Error(baseline.error ?? baseline.reason ?? 'Baseline request failed');
      }
      const headers = baseline.headers ?? {};
      const body = baseline.body ?? '';
      const ctx: ResponseContext = { finalUrl: url, status: baseline.status, headers };

      const doc = isHtmlResponse(headers) && body !== '' ? parseHtml(body) : null;

      // Security: passive headers + HTML body + one CORS/OPTIONS probe + methods.
      const passive = auditResponse({ url, status: baseline.status, headers, body });
      const bodyFindings = doc ? auditPageBody(doc, ctx) : [];

      const probeOrigin = 'https://relay-audit.invalid';
      const cors = await execute({
        method: 'OPTIONS',
        replaceHeaders: true,
        body: '',
        script: '',
        tests: '',
        headers: {
          origin: probeOrigin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      const corsFindings = cors.ok
        ? auditCors(cors.headers ?? {}, probeOrigin)
        : [
            {
              id: 'cors-probe',
              title: 'CORS probe could not complete',
              severity: 'info' as const,
              detail: cors.error ?? cors.reason ?? 'No response',
            },
          ];
      const methodFindings = cors.ok ? auditMethods(cors.headers ?? {}) : [];

      const securityFindings: SecurityFinding[] = [
        ...passive,
        ...bodyFindings,
        ...corsFindings,
        ...methodFindings,
      ];

      // SEO + extraction run only on an HTML response.
      const seo = doc ? analyzeSeo(doc, ctx) : null;
      let extraction: ExtractionSummary | null = null;
      if (doc) {
        extraction = {
          links: extract(doc, ctx, { mode: 'links' }).count,
          images: extract(doc, ctx, { mode: 'images' }).count,
          headings: extract(doc, ctx, { mode: 'headings' }).count,
          tables: extract(doc, ctx, { mode: 'tables' }).count,
          metadata: extract(doc, ctx, { mode: 'meta' }).count,
        };
      }

      setReport(
        buildFullReport({
          target: url,
          seo,
          extraction,
          securityFindings,
          securityScore: securityScore(securityFindings),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="testLab">
      <header className="labHeader">
        <div>
          <p className="labEyebrow">One-click vulnerability &amp; analysis report</p>
          <h3>Full report: security, SEO and extraction</h3>
          <p>
            Sends the request once, then runs the passive security audit
            (headers, cookies, HTML body, CORS and advertised methods), the SEO
            grade, and an extraction summary — in a single pass. Non-destructive:
            no fuzzing, path guessing or injection payloads; the baseline request
            plus one OPTIONS probe.
          </p>
        </div>
        {report ? <ReportActions report={report} /> : <span className="labLimit">2 requests</span>}
      </header>

      <label className="authorizationCheck">
        <input
          type="checkbox"
          checked={authorized}
          disabled={running}
          onChange={(event) => setAuthorized(event.target.checked)}
        />
        <span>I own this target or have explicit authorization to test it.</span>
      </label>

      {error ? <p className="notice bad">{error}</p> : null}

      <button
        type="button"
        className="primary"
        disabled={running}
        onClick={() => void run()}
      >
        {running ? 'Running full report…' : 'Run full report'}
      </button>

      {report ? (
        <>
          <div className="metricGrid">
            <div className="metric">
              <span>Security</span>
              <strong>{report.security.score}/100</strong>
            </div>
            <div className="metric">
              <span>SEO</span>
              <strong>
                {report.overview.seoScore === null
                  ? 'n/a'
                  : `${report.overview.seoGrade} · ${report.overview.seoScore}`}
              </strong>
            </div>
            <div className={report.overview.findingCounts.high > 0 ? 'metric metric--bad' : 'metric'}>
              <span>High</span>
              <strong>{report.overview.findingCounts.high}</strong>
            </div>
            <div className="metric">
              <span>Medium</span>
              <strong>{report.overview.findingCounts.medium}</strong>
            </div>
            <div className="metric">
              <span>Low</span>
              <strong>{report.overview.findingCounts.low}</strong>
            </div>
            <div className="metric">
              <span>Links</span>
              <strong>{report.extraction?.links ?? '—'}</strong>
            </div>
          </div>

          <h4 className="reportSection">Security · {report.security.findings.length} findings</h4>
          <ul className="findingList">
            {report.security.findings.map((finding) => (
              <li key={finding.id} data-severity={finding.severity}>
                <span className="findingSeverity">{finding.severity}</span>
                <div>
                  <strong>{finding.title}</strong>
                  <p>{finding.detail}</p>
                </div>
              </li>
            ))}
          </ul>

          {report.seo ? (
            <>
              <h4 className="reportSection">
                SEO · grade {report.seo.grade} ({report.seo.score}/100)
              </h4>
              <ul className="findingList">
                {report.seo.checks.map((check) => (
                  <li key={check.id} data-severity={SEO_SEVERITY[check.status]}>
                    <span className="findingSeverity">{check.status}</span>
                    <div>
                      <strong>{check.label}</strong>
                      <p>{check.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hint">
              SEO and extraction are skipped because the response is not HTML.
            </p>
          )}

          {report.extraction ? (
            <>
              <h4 className="reportSection">Extraction</h4>
              <div className="severityCounts">
                <span><strong>{report.extraction.links}</strong> links</span>
                <span><strong>{report.extraction.images}</strong> images</span>
                <span><strong>{report.extraction.headings}</strong> headings</span>
                <span><strong>{report.extraction.tables}</strong> tables</span>
                <span><strong>{report.extraction.metadata}</strong> meta</span>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

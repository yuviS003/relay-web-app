'use client';

import {
  downloadText,
  fullReportToCsv,
  reportFilenameBase,
  securityReportToCsv,
  seoReportToCsv,
  type FullReportDocument,
  type SecurityReportDocument,
  type SeoReportDocument,
} from '@/lib/analysis/report';

type AnyReport =
  | SeoReportDocument
  | SecurityReportDocument
  | FullReportDocument;

function toCsvForReport(report: AnyReport): string {
  switch (report.kind) {
    case 'seo':
      return seoReportToCsv(report);
    case 'security':
      return securityReportToCsv(report);
    case 'full':
      return fullReportToCsv(report);
  }
}

/**
 * JSON and CSV download buttons for a built report. The full structured
 * document goes to JSON; the detailed rows go to CSV. Both filenames carry the
 * report kind, target host and a timestamp.
 */
export function ReportActions({ report }: { report: AnyReport }) {
  const base = reportFilenameBase(report.kind, report.target);
  const csv = toCsvForReport(report);

  return (
    <div className="reportActions">
      <span className="reportActionsLabel">Download</span>
      <button
        type="button"
        className="reportDownload"
        onClick={() =>
          downloadText(
            `${base}.json`,
            'application/json',
            JSON.stringify(report, null, 2),
          )
        }
      >
        JSON
      </button>
      <button
        type="button"
        className="reportDownload"
        onClick={() => downloadText(`${base}.csv`, 'text/csv', csv)}
      >
        CSV
      </button>
    </div>
  );
}

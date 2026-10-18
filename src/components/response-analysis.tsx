'use client';

import { useMemo, useState, type CSSProperties } from 'react';

import {
  extract,
  type ExtractMode,
  type ExtractResult,
  type HeadingItem,
  type ImageItem,
  type LinkItem,
  type MetaItem,
  type SelectorItem,
  type TableItem,
} from '@/lib/analysis/extract';
import { isHtmlResponse, parseHtml, type ResponseContext } from '@/lib/analysis/html';
import { buildSeoReport } from '@/lib/analysis/report';
import { analyzeSeo, type SeoStatus } from '@/lib/analysis/seo';
import { ReportActions } from '@/components/report-actions';

type AnalysisInput = {
  body: string;
  headers: Record<string, string>;
  finalUrl: string;
  contentType: string | undefined;
};

/** Maps an SEO status onto the finding severities the CSS already styles. */
const SEO_SEVERITY: Record<SeoStatus, string> = {
  good: 'pass',
  info: 'info',
  warn: 'medium',
  bad: 'high',
};

function Unavailable({ body, contentType }: { body: string; contentType: string | undefined }) {
  if (body.trim() === '') {
    return (
      <p className="notice">
        Send a successful request first; the analysis runs on the response that
        comes back through the relay.
      </p>
    );
  }
  return (
    <p className="notice">
      This response is not HTML{contentType ? ` (content-type: ${contentType})` : ''},
      so there is nothing to analyse here.
    </p>
  );
}

export function SeoPanel({ body, headers, finalUrl, contentType }: AnalysisInput) {
  const report = useMemo(() => {
    if (body.trim() === '' || !isHtmlResponse(headers)) return null;
    const ctx: ResponseContext = { finalUrl, status: 0, headers };
    return analyzeSeo(parseHtml(body), ctx);
  }, [body, headers, finalUrl]);

  if (!report) return <Unavailable body={body} contentType={contentType} />;

  const { facts } = report;
  const metrics: { label: string; value: string }[] = [
    { label: 'Title length', value: `${facts.titleLength}` },
    { label: 'Description', value: `${facts.descriptionLength}` },
    { label: 'Words', value: `${facts.words}` },
    { label: 'Text ratio', value: `${facts.textToHtmlRatio}%` },
    { label: 'Headings', value: `${facts.headingCount}` },
    {
      label: 'Images',
      value: `${facts.images.total} (${facts.images.missingAlt} no alt)`,
    },
    {
      label: 'Links',
      value: `${facts.links.internal} int / ${facts.links.external} ext`,
    },
    { label: 'Open Graph', value: `${facts.openGraph.length}/3` },
  ];

  return (
    <div className="analysis">
      <header className="analysisHeader">
        <div
          className="scoreRing"
          style={{ '--score': `${report.score * 3.6}deg` } as CSSProperties}
        >
          <strong>{report.score}</strong>
          <span>/100</span>
        </div>
        <div className="analysisHeaderBody">
          <p className="analysisGrade">
            Grade <strong>{report.grade}</strong>
          </p>
          <p className="hint">
            {report.facts.indexable
              ? 'The page allows indexing.'
              : 'A robots directive blocks indexing.'}{' '}
            {report.facts.title ?? 'No title'}
          </p>
        </div>
        <ReportActions report={buildSeoReport(report, finalUrl)} />
      </header>

      <div className="metricGrid">
        {metrics.map((metric) => (
          <div className="metric" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </div>

      <ul className="findingList">
        {report.checks.map((check) => (
          <li key={check.id} data-severity={SEO_SEVERITY[check.status]}>
            <span className="findingSeverity">{check.status}</span>
            <div>
              <strong>{check.label}</strong>
              <p>{check.detail}</p>
              {check.recommendation ? (
                <p className="analysisRec">{check.recommendation}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const EXTRACT_MODES: { id: ExtractMode; label: string }[] = [
  { id: 'links', label: 'Links' },
  { id: 'images', label: 'Images' },
  { id: 'headings', label: 'Headings' },
  { id: 'tables', label: 'Tables' },
  { id: 'meta', label: 'Metadata' },
  { id: 'text', label: 'Text' },
  { id: 'selector', label: 'CSS selector' },
];

export function ExtractPanel({ body, headers, finalUrl, contentType }: AnalysisInput) {
  const [mode, setMode] = useState<ExtractMode>('links');
  const [selector, setSelector] = useState('');
  const [copied, setCopied] = useState(false);

  const doc = useMemo(() => {
    if (body.trim() === '' || !isHtmlResponse(headers)) return null;
    return parseHtml(body);
  }, [body, headers]);

  const result = useMemo<ExtractResult | null>(() => {
    if (!doc) return null;
    const ctx: ResponseContext = { finalUrl, status: 0, headers };
    return extract(doc, ctx, { mode, selector });
  }, [doc, finalUrl, headers, mode, selector]);

  if (!doc || !result) return <Unavailable body={body} contentType={contentType} />;

  const copy = () => {
    void navigator.clipboard.writeText(JSON.stringify(result.items, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="analysis">
      <div className="extractControls">
        <div className="chips" role="tablist" aria-label="Extraction mode">
          {EXTRACT_MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              className="chip"
              data-active={mode === option.id}
              aria-pressed={mode === option.id}
              onClick={() => setMode(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="extractCopy"
          disabled={result.count === 0}
          onClick={copy}
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
      </div>

      {mode === 'selector' ? (
        <input
          className="selectorInput"
          type="text"
          spellCheck={false}
          placeholder='CSS selector, e.g. article h2, a.button, [data-id]'
          value={selector}
          onChange={(event) => setSelector(event.target.value)}
        />
      ) : null}

      {result.error ? <p className="notice bad">{result.error}</p> : null}
      {result.note ? <p className="hint">{result.note}</p> : null}
      {!result.error && !result.note ? (
        <p className="hint">
          {result.count} {result.count === 1 ? 'match' : 'matches'}.
        </p>
      ) : null}

      <ExtractItems result={result} />
    </div>
  );
}

function ExtractItems({ result }: { result: ExtractResult }) {
  if (result.count === 0) return null;

  switch (result.mode) {
    case 'links':
      return (
        <ul className="extractList">
          {(result.items as LinkItem[]).map((item, index) => (
            <li key={`${item.href}-${index}`}>
              <span className={item.external ? 'tag tag--ext' : 'tag'}>
                {item.external ? 'ext' : 'int'}
              </span>
              <div>
                <strong>{item.text || '(no text)'}</strong>
                <code>{item.href}</code>
                {item.rel ? <span className="hint">rel={item.rel}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      );
    case 'images':
      return (
        <ul className="extractList">
          {(result.items as ImageItem[]).map((item, index) => (
            <li key={`${item.src}-${index}`}>
              <div>
                <code>{item.src}</code>
                <span className="hint">
                  alt={item.alt === null ? '(missing)' : `"${item.alt}"`}
                  {item.width || item.height
                    ? ` · ${item.width ?? '?'}×${item.height ?? '?'}`
                    : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      );
    case 'headings':
      return (
        <ul className="extractOutline">
          {(result.items as HeadingItem[]).map((item, index) => (
            <li key={index} style={{ paddingInlineStart: `${(item.level - 1) * 1.1}rem` }}>
              <span className="tag">h{item.level}</span> {item.text}
            </li>
          ))}
        </ul>
      );
    case 'meta':
      return (
        <ul className="kvList">
          {(result.items as MetaItem[]).map((item, index) => (
            <li key={`${item.key}-${index}`}>
              <code>{item.key}</code>
              <span>{item.value}</span>
            </li>
          ))}
        </ul>
      );
    case 'text':
      return <pre className="extractText">{(result.items as string[])[0]}</pre>;
    case 'tables':
      return (
        <div className="extractTables">
          {(result.items as TableItem[]).map((table, tableIndex) => (
            <table className="dataTable" key={tableIndex}>
              {table.headers.length > 0 ? (
                <thead>
                  <tr>
                    {table.headers.map((cell, index) => (
                      <th key={index}>{cell}</th>
                    ))}
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      );
    case 'selector':
      return (
        <ul className="extractList">
          {(result.items as SelectorItem[]).map((item, index) => (
            <li key={index}>
              <span className="tag">{item.tag}</span>
              <div>
                {item.text ? <strong>{item.text}</strong> : null}
                {Object.keys(item.attributes).length > 0 ? (
                  <code>
                    {Object.entries(item.attributes)
                      .map(([name, value]) => `${name}="${value}"`)
                      .join(' ')}
                  </code>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      );
    default:
      return null;
  }
}

'use client';

import { useRef, useState, type CSSProperties } from 'react';

import {
  bodySignature,
  summarizeLoad,
  validateLoadPlan,
  type LoadSample,
  type LoadSummary,
} from '@/lib/testing/load';
import { ReportActions } from '@/components/report-actions';
import { isHtmlResponse, parseHtml } from '@/lib/analysis/html';
import { auditPageBody } from '@/lib/analysis/page-security';
import { buildSecurityReport } from '@/lib/analysis/report';
import {
  auditCors,
  auditMethods,
  auditResponse,
  securityScore,
  type SecurityFinding,
  type SecuritySeverity,
} from '@/lib/testing/security';

export type TestingRelayResult = {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBytes?: number;
  durationMs?: number;
  reason?: string;
  error?: string;
};

export type ExecuteRequest = (overrides?: {
  method?: string;
  headers?: Record<string, string>;
  replaceHeaders?: boolean;
  body?: string;
  script?: string;
  tests?: string;
}) => Promise<TestingRelayResult>;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function TrafficLab({ execute }: { execute: ExecuteRequest }) {
  const [count, setCount] = useState(20);
  const [concurrency, setConcurrency] = useState(2);
  const [delayMs, setDelayMs] = useState(250);
  const [authorized, setAuthorized] = useState(false);
  const [running, setRunning] = useState(false);
  const [samples, setSamples] = useState<readonly LoadSample[]>([]);
  const [summary, setSummary] = useState<LoadSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const run = async () => {
    const planError = validateLoadPlan({ count, concurrency, delayMs });
    if (planError) {
      setError(planError);
      return;
    }
    if (!authorized) {
      setError('Confirm that you own or are authorized to test this target.');
      return;
    }

    setError(null);
    setRunning(true);
    setSamples([]);
    setSummary(null);
    cancelled.current = false;
    const collected: LoadSample[] = [];
    const startedAt = performance.now();
    let cursor = 0;

    const worker = async () => {
      while (!cancelled.current) {
        const index = cursor;
        cursor += 1;
        if (index >= count) return;

        const started = performance.now();
        let response: TestingRelayResult;
        try {
          response = await execute();
        } catch (reason) {
          response = {
            ok: false,
            status: 0,
            reason: 'client-error',
            error: reason instanceof Error ? reason.message : String(reason),
          };
        }

        const durationMs = Math.max(
          0,
          Math.round(response.durationMs ?? performance.now() - started),
        );
        const body = response.body ?? '';
        const sample: LoadSample = {
          index: index + 1,
          status: response.status ?? 0,
          durationMs,
          bodyBytes: response.bodyBytes ?? body.length,
          bodySignature: bodySignature(body),
          error: response.ok ? null : (response.error ?? response.reason ?? 'request failed'),
        };
        collected.push(sample);
        setSamples([...collected].sort((a, b) => a.index - b.index));

        if (index + concurrency < count && !cancelled.current) {
          await wait(delayMs);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, count) }, () => worker()),
    );

    const wallTime = Math.max(1, Math.round(performance.now() - startedAt));
    const ordered = [...collected].sort((a, b) => a.index - b.index);
    setSamples(ordered);
    setSummary(summarizeLoad(ordered, wallTime));
    setRunning(false);
  };

  const maxDuration = Math.max(1, ...samples.map((sample) => sample.durationMs));

  return (
    <div className="testLab">
      <header className="labHeader">
        <div>
          <p className="labEyebrow">Bounded traffic run</p>
          <h3>Repeated hits with latency percentiles</h3>
          <p>
            Up to 50 requests, five workers and a minimum 50ms delay. The
            account relay quota still applies, so the lab cannot become an
            unmetered load generator.
          </p>
        </div>
        <span className="labLimit">max 50</span>
      </header>

      <div className="loadControls">
        <label>
          Requests
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            disabled={running}
            onChange={(event) => setCount(Number(event.target.value))}
          />
        </label>
        <label>
          Concurrency
          <input
            type="number"
            min={1}
            max={5}
            value={concurrency}
            disabled={running}
            onChange={(event) => setConcurrency(Number(event.target.value))}
          />
        </label>
        <label>
          Delay (ms)
          <input
            type="number"
            min={50}
            max={30000}
            step={50}
            value={delayMs}
            disabled={running}
            onChange={(event) => setDelayMs(Number(event.target.value))}
          />
        </label>
      </div>

      <label className="authorizationCheck">
        <input
          type="checkbox"
          checked={authorized}
          disabled={running}
          onChange={(event) => setAuthorized(event.target.checked)}
        />
        <span>
          I own this target or have explicit authorization to test it.
        </span>
      </label>

      {error ? <p className="notice bad">{error}</p> : null}

      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={running}
          onClick={() => void run()}
        >
          {running ? `Running ${samples.length}/${count}…` : 'Run traffic test'}
        </button>
        {running ? (
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
            }}
          >
            Stop after active requests
          </button>
        ) : null}
      </div>

      {summary ? (
        <>
          <div className="metricGrid">
            <Metric label="p50" value={`${summary.p50Ms} ms`} />
            <Metric label="p95" value={`${summary.p95Ms} ms`} />
            <Metric label="p99" value={`${summary.p99Ms} ms`} />
            <Metric label="Average" value={`${summary.averageMs} ms`} />
            <Metric
              label="Range"
              value={`${summary.minMs}–${summary.maxMs} ms`}
            />
            <Metric label="Throughput" value={`${summary.requestsPerSecond}/s`} />
            <Metric label="Completed" value={`${summary.total}/${count}`} />
            <Metric
              label="Errors"
              value={`${Math.round(summary.errorRate * 100)}%`}
              bad={summary.failed > 0}
            />
            <Metric
              label="Body variants"
              value={String(summary.bodyVariants)}
              bad={summary.bodyVariants > 1}
            />
          </div>

          <div className="statusDistribution">
            {Object.entries(summary.statuses).map(([status, value]) => (
              <span key={status}>
                <strong>{status}</strong> {value}
              </span>
            ))}
          </div>
        </>
      ) : null}

      {samples.length > 0 ? (
        <div className="latencyChart" aria-label="Latency by request">
          {samples.map((sample) => (
            <span
              key={sample.index}
              className={sample.error ? 'latencyBar latencyBar--bad' : 'latencyBar'}
              style={{ height: `${Math.max(5, (sample.durationMs / maxDuration) * 100)}%` }}
              title={`#${sample.index}: ${sample.status || 'error'} · ${sample.durationMs}ms`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  bad = false,
}: {
  label: string;
  value: string;
  bad?: boolean;
}) {
  return (
    <div className={bad ? 'metric metric--bad' : 'metric'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function SecurityLab({
  url,
  execute,
}: {
  url: string;
  execute: ExecuteRequest;
}) {
  const [authorized, setAuthorized] = useState(false);
  const [running, setRunning] = useState(false);
  const [findings, setFindings] = useState<readonly SecurityFinding[]>([]);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!authorized) {
      setError('Confirm that you own or are authorized to audit this target.');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setError('Enter a complete HTTP or HTTPS URL first.');
      return;
    }

    setRunning(true);
    setError(null);
    setFindings([]);

    try {
      const baseline = await execute();
      if (!baseline.ok || baseline.status === undefined) {
        throw new Error(baseline.error ?? baseline.reason ?? 'Baseline request failed');
      }

      const passive = auditResponse({
        url,
        status: baseline.status,
        headers: baseline.headers ?? {},
        body: baseline.body ?? '',
      });

      // Header-level findings cannot see mixed content, tabnabbing, forms
      // posting over HTTP, or the third-party script surface. For an HTML
      // response, parse the body and add those. Still passive: no request is
      // sent for this; it reads the baseline response already in hand.
      const bodyFindings =
        isHtmlResponse(baseline.headers ?? {}) && (baseline.body ?? '') !== ''
          ? auditPageBody(parseHtml(baseline.body ?? ''), {
              finalUrl: url,
              status: baseline.status,
              headers: baseline.headers ?? {},
            })
          : [];

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

      // The OPTIONS probe's own headers reveal the advertised method set; read
      // them rather than sending anything new.
      const methodFindings = cors.ok ? auditMethods(cors.headers ?? {}) : [];

      setFindings([...passive, ...bodyFindings, ...corsFindings, ...methodFindings]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };

  const score = securityScore(findings);

  return (
    <div className="testLab">
      <header className="labHeader">
        <div>
          <p className="labEyebrow">Non-destructive audit</p>
          <h3>Security posture and CORS probe</h3>
          <p>
            Analyses returned headers, cookies and credential-shaped content,
            inspects the HTML body for mixed content, tabnabbing, insecure
            password forms and third-party scripts, then sends one OPTIONS
            request with a synthetic origin. No path scanning, password
            attempts or injection payloads.
          </p>
        </div>
        {findings.length > 0 ? (
          <div className="scoreRing" style={{ '--score': `${score * 3.6}deg` } as CSSProperties}>
            <strong>{score}</strong>
            <span>/100</span>
          </div>
        ) : (
          <span className="labLimit">2 requests</span>
        )}
      </header>

      <label className="authorizationCheck">
        <input
          type="checkbox"
          checked={authorized}
          disabled={running}
          onChange={(event) => setAuthorized(event.target.checked)}
        />
        <span>I own this target or have explicit authorization to audit it.</span>
      </label>

      {error ? <p className="notice bad">{error}</p> : null}

      <button
        type="button"
        className="primary"
        disabled={running}
        onClick={() => void run()}
      >
        {running ? 'Auditing…' : 'Run security audit'}
      </button>

      {findings.length > 0 ? (
        <>
          <div className="auditSummary">
            <div className="severityCounts">
              {(['high', 'medium', 'low', 'info', 'pass'] as SecuritySeverity[]).map(
                (severity) => {
                  const count = findings.filter((f) => f.severity === severity).length;
                  return (
                    <span
                      key={severity}
                      data-severity={severity}
                      data-empty={count === 0}
                    >
                      <strong>{count}</strong> {severity}
                    </span>
                  );
                },
              )}
            </div>
            <ReportActions report={buildSecurityReport(findings, score, url)} />
          </div>

          <ul className="findingList">
            {findings.map((finding) => (
              <li key={finding.id} data-severity={finding.severity}>
                <span className="findingSeverity">{finding.severity}</span>
                <div>
                  <strong>{finding.title}</strong>
                  <p>{finding.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

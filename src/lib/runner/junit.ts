import type { RunSummary } from './types';

/*
 * JUnit XML, because that is what pipelines already read.
 *
 * One testsuite per run and one testcase per assertion, so a failing
 * expectation shows up as the named test it was written as rather than as a
 * step that "failed". A step with no assertions still produces one testcase:
 * a collection without expectations should report that it ran, and a blocked
 * or unreachable request must not vanish from the report.
 */

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Control characters are not valid XML 1.0 content and some readers reject
    // the whole document over one of them.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/\n/g, ' ');
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

export function toJUnitXml(summary: RunSummary): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  // A skipped step is reported as skipped, never as a failure: a pipeline
  // that bails on the first error would otherwise read every unrun step as
  // another broken test.
  const failures = summary.steps.reduce((count, step) => {
    if (step.assertions.results.length > 0) return count + step.assertions.failed;
    return count + (step.status === 'failed' || step.status === 'blocked' ? 1 : 0);
  }, 0);
  const skipped = summary.steps.filter(
    (step) => step.status === 'skipped' || step.status === 'aborted',
  ).length;
  const tests = summary.steps.reduce(
    (count, step) => count + Math.max(1, step.assertions.results.length),
    0,
  );

  lines.push(
    `<testsuites name="${escapeAttribute(summary.collection)}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${seconds(
      summary.durationMs,
    )}">`,
  );
  lines.push(
    `  <testsuite name="${escapeAttribute(summary.collection)}" tests="${tests}" failures="${failures}" skipped="${skipped}" timestamp="${escapeAttribute(
      summary.startedAt,
    )}" time="${seconds(summary.durationMs)}">`,
  );

  for (const step of summary.steps) {
    const classname = escapeAttribute(`${step.method} ${step.name}`);

    if (step.assertions.results.length > 0) {
      for (const result of step.assertions.results) {
        lines.push(
          `    <testcase classname="${classname}" name="${escapeAttribute(
            result.name,
          )}" time="${seconds(step.durationMs)}">`,
        );
        if (!result.ok) {
          lines.push(
            `      <failure message="${escapeAttribute(
              result.detail ?? 'assertion failed',
            )}">${escapeText(result.detail ?? 'assertion failed')}</failure>`,
          );
        }
        lines.push('    </testcase>');
      }
      continue;
    }

    lines.push(
      `    <testcase classname="${classname}" name="${escapeAttribute(
        step.url,
      )}" time="${seconds(step.durationMs)}">`,
    );
    if (step.status === 'skipped' || step.status === 'aborted') {
      lines.push(
        `      <skipped message="${escapeAttribute(step.error ?? step.status)}"/>`,
      );
    } else if (step.status !== 'passed') {
      const detail = step.error ?? `step ${step.status}`;
      lines.push(
        `      <failure message="${escapeAttribute(detail)}">${escapeText(
          detail,
        )}</failure>`,
      );
    }
    lines.push('    </testcase>');
  }

  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

/** A one-line-per-step summary for a terminal. */
export function toTextReport(summary: RunSummary): string {
  const mark: Record<string, string> = {
    passed: '✓',
    failed: '✗',
    blocked: '⊘',
    skipped: '–',
    aborted: '–',
  };
  const lines = summary.steps.map((step) => {
    const head = `  ${mark[step.status] ?? '?'} ${step.method} ${step.name}`;
    const status = step.httpStatus === null ? '—' : String(step.httpStatus);
    const assertions =
      step.assertions.results.length > 0
        ? ` · ${step.assertions.passed}/${step.assertions.results.length} assertions`
        : '';
    const failedCaptures = step.captures
      .filter((capture) => !capture.ok)
      .map((capture) => `${capture.name}: ${capture.detail}`);
    const detail = step.error ? `\n      ${step.error}` : '';
    const captures =
      failedCaptures.length > 0 ? `\n      capture ${failedCaptures.join('; ')}` : '';
    return `${head} → ${status} in ${step.durationMs}ms${assertions}${detail}${captures}`;
  });

  return [
    `${summary.collection}: ${summary.passed}/${summary.total} steps passed`,
    ...lines,
    `  assertions ${summary.assertionsPassed} passed, ${summary.assertionsFailed} failed · ${summary.durationMs}ms total`,
  ].join('\n');
}

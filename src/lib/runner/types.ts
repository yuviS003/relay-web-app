/*
 * Running a whole collection, in order, with values flowing between requests.
 *
 * The shapes live apart from the execution so the same definitions serve the
 * browser panel, the JUnit writer and the command-line runner. Nothing here
 * imports a transport: the runner is handed one, which is what lets it be
 * tested without a network and reused from Node against a deployed instance.
 */

// The persisted shape and its validation live with the rest of the saved
// documents; the runner consumes it rather than defining a second version.
import type { Capture, CaptureSource, RequestAuthSpec } from '../store/types';

export type { Capture, CaptureSource, RequestAuthSpec };

export type RunnableRequest = {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: readonly { name: string; value: string; enabled: boolean }[];
  body: string;
  preRequestScript: string;
  testScript: string;
  captures?: readonly Capture[];
  /**
   * Carried through to the relay, which applies it after substitution. A run
   * that dropped it would send a collection's authenticated requests
   * unauthenticated and report 401s as the collection's own fault.
   */
  auth?: RequestAuthSpec | undefined;
};

export type AssertionResult = {
  name: string;
  ok: boolean;
  detail?: string | undefined;
};

/*
 * Every optional field is spelled `| undefined` on purpose: this shape is
 * assembled from a parsed HTTP response where any of them can legitimately be
 * missing, and under exactOptionalPropertyTypes "absent" and "present but
 * undefined" are different types.
 */
export type RelayAttempt = {
  ok: boolean;
  blocked?: boolean | undefined;
  status?: number | undefined;
  statusText?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  assertions?:
    | {
        ok: boolean;
        passed?: number | undefined;
        failed?: number | undefined;
        results?: readonly AssertionResult[] | undefined;
        error?: string | undefined;
      }
    | null
    | undefined;
  /** Variables a pre-request script set, so the next step can use them. */
  scriptVariables?: Record<string, string> | undefined;
};

export type RelayPayload = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  script: string;
  tests: string;
  variables: Record<string, string>;
  /** Omitted entirely when the request has no auth configured. */
  auth?: RequestAuthSpec | undefined;
};

export type Transport = (payload: RelayPayload) => Promise<RelayAttempt>;

export type CaptureOutcome = {
  name: string;
  from: CaptureSource;
  path: string;
  ok: boolean;
  /** Present when the capture succeeded; truncated for display. */
  value?: string;
  detail?: string;
};

export type StepStatus = 'passed' | 'failed' | 'blocked' | 'skipped' | 'aborted';

export type StepOutcome = {
  id: string;
  name: string;
  method: string;
  url: string;
  status: StepStatus;
  httpStatus: number | null;
  statusText: string;
  durationMs: number;
  assertions: { passed: number; failed: number; results: AssertionResult[] };
  captures: CaptureOutcome[];
  error: string | null;
};

export type RunSummary = {
  collection: string;
  startedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  assertionsPassed: number;
  assertionsFailed: number;
  /** True when every step that ran passed and nothing was left unrun. */
  ok: boolean;
  steps: StepOutcome[];
  /** The variable map as it stood at the end, for inspection after a run. */
  variables: Record<string, string>;
};

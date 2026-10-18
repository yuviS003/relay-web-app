'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { BootScreen } from '@/components/boot-screen';
import { CommandPalette, type Command } from '@/components/command-palette';
import { Logo } from '@/components/logo';
import { PasswordField } from '@/components/password-field';
import { PwaInstall } from '@/components/pwa-install';
import { AssistPanel } from '@/components/assist-panel';
import { AuthEditor } from '@/components/auth-editor';
import { BodyViewer } from '@/components/body-viewer';
import { CaptureEditor } from '@/components/capture-editor';
import { CollectionRunner } from '@/components/collection-runner';
import { CookiePanel } from '@/components/cookie-panel';
import { GraphQLEditor } from '@/components/graphql-editor';
import { HistoryPanel } from '@/components/history-panel';
import { ImportDialog } from '@/components/import-dialog';
import { MfaSetupDialog } from '@/components/mfa-dialog';
import { RequestList, type RequestMove } from '@/components/request-list';
import { VariableReport } from '@/components/variable-report';
import {
  applySetCookies,
  cookieHeaderFor,
  EMPTY_JAR,
  pruneJar,
  removeCookie,
  type CookieJar,
} from '@/lib/cookies';
import { summariseGraphQLResult } from '@/lib/graphql';
import {
  clearHistory,
  listHistory,
  recordHistory,
  type HistoryEntry,
} from '@/lib/history/store';
import type { ImportResult } from '@/lib/import/openapi';
import {
  findPlaceholderNames,
  findScriptAssignments,
  substitute,
} from '@/lib/placeholders';
import { reportPlaceholders, resolveVariables as layerVariables } from '@/lib/variables';
import { RequestTabs } from '@/components/request-tabs';
import { NetworkChip } from '@/components/network-chip';
import {
  readLinkInfo,
  recordSample,
  summariseNetwork,
  type NetworkSample,
} from '@/lib/net/health';
import { SentRequestPanel, type SentRequest } from '@/components/sent-request';
import { SettingsPanel } from '@/components/settings-panel';
import { StreamPanel } from '@/components/stream-panel';
import { Tour, type TourStep } from '@/components/tour';
import { ExtractPanel, SeoPanel } from '@/components/response-analysis';
import { VulnReport } from '@/components/vuln-report';
import { generateAssertions } from '@/lib/analysis/testgen';
import {
  SecurityLab,
  TrafficLab,
  type ExecuteRequest,
  type TestingRelayResult,
} from '@/components/testing-lab';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  WorkbenchDialogs,
  type NewRequestInput,
  type NewSecretInput,
  type WorkbenchDialog,
} from '@/components/workbench-dialogs';
import { formatBody } from '@/lib/body-format';
import { defaultBodyMode, defaultHeaders } from '@/lib/request-defaults';
import { CODE_TARGETS, generateCode, type CodeTarget } from '@/lib/codegen';
import { parseCurl } from '@/lib/import/curl';
import { SAMPLE_ASSERTIONS, type AssertionOutcome } from '@/lib/scripting/assertions';
import {
  decryptSecret,
  createSalt,
  deriveKey,
  encryptSecret,
} from '@/lib/crypto/secrets';
import {
  COMMON_HEADERS,
  CONTENT_TYPE_PRESETS,
  findHeader,
} from '@/lib/headers-catalog';
import {
  compareCollections,
  HTTP_METHODS,
  type BodyMode,
  type Collection,
  type Environment,
  type HeaderPair,
  type RequestSpec,
} from '@/lib/store/types';

import type { SessionUser } from './page';

/*
 * The guided tour.
 *
 * Steps point at the live interface through data-tour attributes rather than
 * styling classes, so restyling a pane cannot silently break the tour, and a
 * step whose target is absent for this visitor is dropped rather than shown
 * pointing at nothing.
 */
const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Relay',
    body: 'Compose and send HTTP requests from this tab. Everything leaves through a proxy that refuses private addresses, and the workspace comes preloaded with a runnable sample of every feature. This takes about two minutes.',
  },
  {
    id: 'collections',
    target: '[data-tour="sidebar"]',
    title: 'Collections',
    body: 'Six sample collections are already here, one per feature, pointing at public demo APIs that answer right now. Drag a request to reorder it, drop it on another collection to move it, and use the ••• menu for rename, move and delete.',
  },
  {
    id: 'runner',
    target: '[data-tour="collection-run"]',
    title: 'Run a whole collection',
    body: '▶ sends every request in order and reports steps, assertions and captures. “Chained run” signs in, captures the token and uses it twice. The same run is headless: npm run collection, with JUnit output for a pipeline.',
  },
  {
    id: 'request',
    target: '[data-tour="request-bar"]',
    title: 'Method and URL',
    body: 'Pick a method and paste a URL. {{variables}} from the active environment are substituted anywhere in the URL, headers or body.',
  },
  {
    id: 'send',
    target: '[data-tour="send"]',
    title: 'Send it',
    body: 'Ctrl/Cmd+Enter does the same. The relay resolves the hostname first and refuses loopback, private and cloud-metadata addresses, including after a redirect.',
  },
  {
    id: 'request-tabs',
    target: '[data-tour="request-tabs"]',
    title: 'Params, headers, body, scripts',
    body: 'Header names autocomplete, each body format keeps its own draft, and pre-request scripts run in a WebAssembly sandbox with no network or filesystem.',
  },
  {
    id: 'auth',
    target: '[data-tour="tab-auth"]',
    title: 'Auth, applied server-side',
    body: 'Basic, bearer, AWS SigV4 and OAuth2 client credentials. Write the credentials as {{variables}} and the relay resolves them at send time — a signature has to cover the exact bytes that go out, and a secret key has no business in a page script.',
  },
  {
    id: 'vars',
    target: '[data-tour="tab-vars"]',
    title: 'Where a variable came from',
    body: 'Three layers: the collection, the selected environment, then scripts and captures. The Vars tab shows what each {{placeholder}} resolves to and flags the unset ones, because an unresolved name is sent literally.',
  },
  {
    id: 'cookies',
    target: '[data-tour="tab-cookies"]',
    title: 'Cookie jar',
    body: 'Set-Cookie is collected from every redirect hop, not just the last, and sent back to matching hosts. The jar is in this tab’s memory only and is never saved: cookies are credentials.',
  },
  {
    id: 'graphql',
    target: '[data-tour="tab-graphql"]',
    title: 'GraphQL and streaming',
    body: 'The GraphQL tab edits a document, its variables and the schema it can introspect, writing straight into the request body. Next to it, Stream keeps a connection open for server-sent events under the same guard and byte cap.',
  },
  {
    id: 'response',
    target: '[data-tour="response"]',
    title: 'Read the response',
    body: 'A JSON tree with a path filter, a sandboxed HTML preview, and a hexdump for binary. Past the body there is a security audit, SEO grading and extraction, all computed in this browser from what the relay already fetched.',
  },
  {
    id: 'history',
    target: '[data-tour="response"]',
    title: 'History and diffing',
    body: 'Every send is recorded in this browser. Open History, pick two responses of the same request and the diff reports only what moved — status, headers and body. Try it on “Changing payload to diff”.',
  },
  {
    id: 'environment',
    target: '[data-tour="environment"]',
    title: 'Environments and secrets',
    body: 'Switch environments here. Secret values are encrypted in your browser with a passphrase that never reaches the server.',
    audience: 'account',
  },
  {
    id: 'guest',
    title: 'You are browsing as a guest',
    body: 'Send and analyse as much as you like. Signing in is only needed to save work, and the starter collection resets when you leave.',
    audience: 'guest',
  },
  {
    id: 'palette',
    target: '[data-tour="palette"]',
    title: 'Everything from the keyboard',
    body: 'Ctrl/Cmd+K opens the command palette. Ctrl/Cmd+S saves and Ctrl/Cmd+Enter sends, both while a field has focus.',
  },
  {
    id: 'import',
    target: '[data-tour="palette"]',
    title: 'Bring your own collection',
    body: 'The palette also imports: an OpenAPI document or a Postman collection becomes requests with sample bodies, and a pasted cURL command becomes one request.',
  },
  {
    id: 'settings',
    target: '[data-tour="settings"]',
    title: 'Account and security',
    body: 'Settings holds your profile, password, passkeys and optional two-factor authentication, and can replay this tour whenever you like.',
    audience: 'account',
  },
  {
    id: 'account-data',
    target: '[data-tour="settings"]',
    title: 'Your data stays yours',
    body: 'Settings exports everything as JSON — collections, environments, sessions, with no password hashes or secrets — and deletes the account outright, immediately and without a backup.',
    audience: 'account',
  },
];

const TOUR_SEEN_KEY = 'wac:tour-seen';

type RelayResult = {
  ok?: boolean;
  /** The request as the relay sent it: substituted, with auth applied. */
  sent?: SentRequest;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBytes?: number;
  durationMs?: number;
  hops?: { url: string; address: string; status: number }[];
  setCookies?: string[];
  logs?: string[];
  assertions?: {
    ok: boolean;
    results?: AssertionOutcome[];
    logs?: string[];
    passed?: number;
    failed?: number;
    error?: string;
  } | null;
  reason?: string;
  cause?: string;
  error?: string;
  quotaRemaining?: number;
};

/*
 * The relay's detail sentence is concatenated with an explanation below it, and
 * the guard's details carry no trailing punctuation, so without this the two
 * ran together as "… could not be resolved The proxy refuses …".
 */
function withStop(detail: string | undefined): string {
  if (!detail) return '';
  return /[.!?]$/.test(detail.trim()) ? detail : `${detail}.`;
}

/*
 * A refusal is explained by what actually happened.
 *
 * Every block used to be described as a private-address refusal, so a
 * hostname that does not exist was answered with "the proxy refuses private,
 * loopback and link-local addresses" — which points the reader at a security
 * rule when the real problem is usually a typo in the URL.
 */
function explainRefusal(
  reason: string | undefined,
  cause: string | undefined,
): string | null {
  if (reason !== 'blocked') return null;
  switch (cause) {
    case 'unresolvable-host':
      return ' No DNS record was found for that hostname, so nothing was contacted. Check the spelling, or whether the name only resolves on a private network.';
    case 'blocked-address':
      return ' The proxy refuses private, loopback and link-local addresses, including when a redirect points at one.';
    case 'unsupported-scheme':
      return ' Only http and https targets are relayed.';
    case 'embedded-credentials':
      return ' Credentials in the URL are refused; send them as a header instead.';
    case 'invalid-url':
      return ' The URL could not be parsed. A scheme like https:// is required.';
    case 'url-too-long':
      return ' The URL exceeds the 2048-character limit.';
    default:
      return null;
  }
}

type RequestTab =
  | 'params'
  | 'headers'
  | 'sent'
  | 'auth'
  | 'body'
  | 'graphql'
  | 'vars'
  | 'cookies'
  | 'stream'
  | 'script'
  | 'tests'
  | 'traffic'
  | 'security'
  | 'report'
  | 'assist'
  | 'code';
type ResponseTab =
  | 'body'
  | 'headers'
  | 'tests'
  | 'trace'
  | 'history'
  | 'seo'
  | 'extract';

const BLANK: RequestSpec = {
  id: 'scratch',
  name: 'Untitled request',
  method: 'GET',
  url: '',
  headers: defaultHeaders('GET'),
  body: '',
  bodyMode: defaultBodyMode('GET'),
  preRequestScript: '',
  testScript: '',
};

/** Base64 of the UTF-8 bytes; btoa alone throws on a non-ASCII password. */
function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The Authorization header an auth block would produce, for the two kinds that
 * are a pure function of their inputs.
 *
 * SigV4 and OAuth2 are deliberately absent: one signs the exact bytes at the
 * moment of sending and the other needs a token fetched from an endpoint, so
 * neither belongs in a snippet generated before either has happened. The Code
 * tab says so, and offers the exact headers of the last real send instead.
 *
 * The rules here mirror lib/signing/apply.ts on purpose — including tolerating
 * a token that already carries its scheme.
 */
function staticAuthHeader(
  auth: RequestSpec['auth'],
  resolve: (value: string) => string,
): { name: string; value: string } | null {
  if (!auth || auth.kind === 'none') return null;
  if (auth.kind === 'basic') {
    const user = resolve(auth.username ?? '');
    const secret = resolve(auth.password ?? '');
    return { name: 'authorization', value: `Basic ${base64Utf8(`${user}:${secret}`)}` };
  }
  if (auth.kind === 'bearer') {
    const token = resolve(auth.token ?? '').trim();
    if (token === '') return null;
    return {
      name: 'authorization',
      value: /^bearer\s/i.test(token) ? token : `Bearer ${token}`,
    };
  }
  return null;
}

function statusClass(status: number | undefined): string {
  if (status === undefined) return 'codeErr';
  if (status < 300) return 'code2xx';
  if (status < 400) return 'code3xx';
  if (status < 500) return 'code4xx';
  return 'code5xx';
}

/*
 * Pretty-printing moved into the body viewer, which decides how to render a
 * payload from its content type and its contents (tree, raw, preview, hex)
 * rather than reformatting the text ahead of time.
 */

/** Splits a URL into its path part and its query pairs. */
function readQuery(url: string): { base: string; pairs: HeaderPair[] } {
  const markerIndex = url.indexOf('?');
  if (markerIndex === -1) return { base: url, pairs: [] };

  const base = url.slice(0, markerIndex);
  const pairs: HeaderPair[] = [];
  for (const chunk of url.slice(markerIndex + 1).split('&')) {
    if (chunk === '') continue;
    const equals = chunk.indexOf('=');
    pairs.push({
      name: equals === -1 ? chunk : chunk.slice(0, equals),
      value: equals === -1 ? '' : chunk.slice(equals + 1),
      enabled: true,
    });
  }
  return { base, pairs };
}

function writeQuery(base: string, pairs: readonly HeaderPair[]): string {
  const active = pairs.filter((pair) => pair.enabled && pair.name.trim() !== '');
  if (active.length === 0) return base;
  return `${base}?${active
    .map((pair) => `${pair.name}=${pair.value}`)
    .join('&')}`;
}

export function Workbench({
  email,
  mode,
  account = null,
  onSignedOut,
  onRequireSignIn,
  onAccountChanged,
}: {
  email: string;
  mode: 'accounts' | 'local' | 'degraded' | 'guest';
  account?: SessionUser | null;
  onSignedOut: () => void;
  onRequireSignIn: () => void;
  onAccountChanged?: () => void | Promise<void>;
}) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [spec, setSpec] = useState<RequestSpec>(BLANK);
  const [openRequests, setOpenRequests] = useState<RequestSpec[]>([]);
  /** The request a rename or delete dialog is about. */
  const [requestTarget, setRequestTarget] = useState<RequestSpec | null>(null);
  const [activeEnv, setActiveEnv] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [requestTab, setRequestTab] = useState<RequestTab>('params');
  const [responseTab, setResponseTab] = useState<ResponseTab>('body');
  const [codeTarget, setCodeTarget] = useState<CodeTarget>('curl');
  /** Snippets carry real values by default; off shows the saved form. */
  const [codeResolve, setCodeResolve] = useState(true);
  const [codeFromSent, setCodeFromSent] = useState(false);
  const [sending, setSending] = useState(false);
  /*
   * Timings from real sends, for the network indicator. Kept here rather than
   * inside the chip so every path that reaches the relay contributes — the
   * send button, the runner, the labs.
   */
  const [netSamples, setNetSamples] = useState<readonly NetworkSample[]>([]);
  /*
   * One response per request, kept for as long as the tab is open.
   *
   * A single `result` meant switching tabs threw the previous response away:
   * you came back to an empty pane, with no body, no tests and no trace, for a
   * request you had just sent. Keyed by request id and held in memory for the
   * session, the way a desktop client does it. Closing the tab is what
   * discards it.
   */
  const [results, setResults] = useState<Record<string, RelayResult | null>>({});

  /** The active request's response, and a setter scoped to it. */
  const result = results[spec.id] ?? null;
  const setResult = useCallback(
    (next: RelayResult | null) => {
      setResults((current) => ({ ...current, [spec.id]: next }));
    },
    [spec.id],
  );
  const [bodyFormatError, setBodyFormatError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<WorkbenchDialog>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'bad' | 'good' } | null>(
    null,
  );
  const [runnerCollectionId, setRunnerCollectionId] = useState<string | null>(null);
  /*
   * The cookie jar lives here, in memory, for the tab's lifetime. Cookies are
   * credentials: persisting them would mean writing someone's session into a
   * browser profile they did not choose to put it in.
   */
  const [jar, setJar] = useState<CookieJar>(EMPTY_JAR);
  const [history, setHistory] = useState<readonly HistoryEntry[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  /*
   * Both onboarding decisions are remembered per viewer, not once per mount.
   * Signing up does not remount this component — the sign-in card is an
   * overlay on top of it — so a single boolean would mean a visitor who
   * skipped the guest tour never saw the one their new account is owed.
   */
  const [tourSettledFor, setTourSettledFor] = useState<string | null>(null);
  const [mfaOfferOpen, setMfaOfferOpen] = useState(false);
  const [mfaOfferedFor, setMfaOfferedFor] = useState<string | null>(null);

  /*
   * Also used to resync after a failed write: the sidebar updates optimistically
   * so a drag feels immediate, and the server copy is the only thing that can
   * say what actually persisted.
   */
  const loadWorkspace = useCallback(async (selectFirst = false) => {
    const response = await fetch('/api/workspace', { cache: 'no-store' });
    const data = await response.json();
    setCollections(Array.isArray(data.collections) ? data.collections : []);
    setEnvironments(Array.isArray(data.environments) ? data.environments : []);
    if (!selectFirst) return;
    const first = data.collections?.[0]?.requests?.[0] as RequestSpec | undefined;
    if (first) {
      setSpec(first);
      setOpenRequests([first]);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await loadWorkspace(true);
      } catch {
        setNotice({ text: 'Could not load the workspace.', tone: 'bad' });
      } finally {
        setWorkspaceLoading(false);
      }
    })();
  }, [email, mode, loadWorkspace]);

  const guest = mode === 'guest';

  /*
   * Onboarding, in order: the tour explains the app, and only once it is out
   * of the way does the optional second factor get offered. Two overlays at
   * once would make the first thing a new account sees a stack of modals.
   *
   * "Seen" is remembered per account on the server, so a fresh account is
   * toured on whatever device it first signs in from, and in localStorage for
   * guests and local mode, who have nowhere else to put it.
   */
  const viewer = account?.id ?? 'guest';

  /*
   * Only a real account can remember this server-side. In local mode, and
   * when the database is unreachable, there is nowhere to write the flag — so
   * the local one decides. Trusting the account's flag in those modes meant a
   * tour that could never be dismissed: it reopened every time the session
   * was re-read, because the write that was supposed to record the dismissal
   * had nowhere to land.
   */
  const remembersTour = mode === 'accounts' && account !== null;

  useEffect(() => {
    if (workspaceLoading || tourSettledFor === viewer) return;
    let seenLocally = false;
    try {
      seenLocally = window.localStorage.getItem(TOUR_SEEN_KEY) === 'yes';
    } catch {
      // Storage can be blocked; that only means the tour offers itself again.
    }
    const seen = remembersTour ? (account?.tourDone ?? false) : seenLocally;
    setTourSettledFor(viewer);
    if (!seen) setTourOpen(true);
  }, [workspaceLoading, tourSettledFor, viewer, account, remembersTour]);

  const closeTour = useCallback(async () => {
    setTourOpen(false);
    try {
      window.localStorage.setItem(TOUR_SEEN_KEY, 'yes');
    } catch {
      // A browser with storage blocked simply gets the tour again next time.
    }
    if (mode !== 'accounts' || !account) return;
    // Skipping counts as seen: the alternative is a prompt that returns on
    // every sign-in, and Settings can replay it on demand.
    await fetch('/api/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'tour-done', done: true }),
    }).catch(() => undefined);
    await onAccountChanged?.();
  }, [account, mode, onAccountChanged]);

  useEffect(() => {
    if (tourOpen || tourSettledFor !== viewer || mfaOfferedFor === viewer) return;
    // Never on top of something the user opened themselves.
    if (settingsOpen) return;
    if (!account?.offerMfa || mode !== 'accounts') return;
    setMfaOfferOpen(true);
    setMfaOfferedFor(viewer);
  }, [tourOpen, tourSettledFor, mfaOfferedFor, settingsOpen, viewer, account, mode]);

  const query = useMemo(() => readQuery(spec.url), [spec.url]);

  /*
   * The stored body mode is authoritative. Older saved requests did not have
   * it, so infer from Content-Type; a non-empty body with no matching header is
   * plain text rather than "None" (the mismatch shown in the screenshot).
   */
  const activeContentType = useMemo<BodyMode>(() => {
    if (spec.bodyMode) return spec.bodyMode;
    const header = spec.headers.find(
      (pair) => pair.enabled && pair.name.trim().toLowerCase() === 'content-type',
    );
    const value = header?.value.split(';')[0]?.trim().toLowerCase() ?? '';
    const matched = CONTENT_TYPE_PRESETS.find((preset) => preset.contentType === value)?.id;
    if (matched) return matched;
    return spec.body.trim() === '' ? 'none' : 'text';
  }, [spec.body, spec.bodyMode, spec.headers]);
  const environment = useMemo(
    () => environments.find((candidate) => candidate.id === activeEnv) ?? null,
    [environments, activeEnv],
  );

  /*
   * Open request tabs keep their own in-progress copy, so switching away does
   * not discard an unsaved URL or body. Every spec change refreshes only the
   * active tab.
   */
  useEffect(() => {
    if (workspaceLoading) return;
    setOpenRequests((current) => {
      const exists = current.some((request) => request.id === spec.id);
      return exists
        ? current.map((request) => (request.id === spec.id ? spec : request))
        : [...current, spec];
    });
  }, [spec, workspaceLoading]);

  const openRequest = useCallback(
    (request: RequestSpec) => {
      // Reopening a request from the sidebar uses the in-progress tab copy when
      // one exists, so an unsaved URL or body is not silently replaced by the
      // last saved database version.
      const inProgress = openRequests.find((candidate) => candidate.id === request.id);
      setSpec(inProgress ?? request);
      // The response stays with the request, so coming back to a tab shows
      // what it returned rather than an empty pane.
      setNotice(null);
    },
    [openRequests],
  );

  const closeRequest = useCallback(
    (id: string) => {
      const index = openRequests.findIndex((request) => request.id === id);
      const remaining = openRequests.filter((request) => request.id !== id);
      setOpenRequests(remaining);

      if (spec.id === id) {
        setSpec(
          remaining[Math.min(Math.max(index, 0), remaining.length - 1)] ?? BLANK,
        );
      }
      // Closing the tab is the only thing that throws the response away.
      setResults((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    [openRequests, spec.id],
  );

  const patch = useCallback((changes: Partial<RequestSpec>) => {
    setSpec((current) => ({ ...current, ...changes }));
  }, []);

  const switchBodyMode = useCallback(
    (mode: BodyMode) => {
      const preset = CONTENT_TYPE_PRESETS.find((candidate) => candidate.id === mode);
      if (!preset) return;
      const drafts = {
        ...(spec.bodyDrafts ?? {}),
        [activeContentType]: spec.body,
      };
      const headers = spec.headers.filter(
        (pair) => pair.name.trim().toLowerCase() !== 'content-type',
      );
      if (preset.contentType) {
        headers.unshift({ name: 'content-type', value: preset.contentType, enabled: true });
      }
      const nextBody = mode === 'none' ? '' : (drafts[mode] ?? preset.sample);
      setBodyFormatError(null);
      patch({
        headers,
        bodyMode: mode,
        bodyDrafts: { ...drafts, [mode]: nextBody },
        body: nextBody,
      });
    },
    [activeContentType, patch, spec.body, spec.bodyDrafts, spec.headers],
  );

  const applyBodyFormat = useCallback(
    (compact: boolean) => {
      const formatted = formatBody(activeContentType, spec.body, compact);
      if (!formatted.ok) {
        setBodyFormatError(formatted.error);
        return;
      }
      setBodyFormatError(null);
      patch({
        body: formatted.value,
        bodyMode: activeContentType,
        bodyDrafts: {
          ...(spec.bodyDrafts ?? {}),
          [activeContentType]: formatted.value,
        },
      });
    },
    [activeContentType, patch, spec.body, spec.bodyDrafts],
  );

  const setHeader = useCallback((index: number, changes: Partial<HeaderPair>) => {
    setSpec((current) => ({
      ...current,
      headers: current.headers.map((pair, i) =>
        i === index ? { ...pair, ...changes } : pair,
      ),
    }));
  }, []);

  const setQueryPair = useCallback(
    (index: number, changes: Partial<HeaderPair>) => {
      const next = query.pairs.map((pair, i) =>
        i === index ? { ...pair, ...changes } : pair,
      );
      patch({ url: writeQuery(query.base, next) });
    },
    [patch, query],
  );

  /*
   * Secrets are decrypted here, in the browser, so the passphrase never
   * reaches the server. The decrypted value does travel to the proxy, because
   * the proxy has to forward it; what the server never receives is the key.
   */
  const resolveVariables = useCallback(
    async (
      forCollection?: Collection | null,
    ): Promise<Record<string, string> | { error: string }> => {
      /*
       * Layered, lowest first: the collection's own variables, then the
       * selected environment. Scripts and captures override both later, inside
       * the relay and the runner. See lib/variables.ts.
       */
      const owner =
        forCollection ??
        collections.find((collection) =>
          collection.requests.some((request) => request.id === spec.id),
        ) ??
        null;
      const out: Record<string, string> = {};
      for (const variable of owner?.variables ?? []) {
        out[variable.name] = variable.value;
      }
      if (!environment) return out;

      const secrets = environment.variables.filter((variable) => variable.secret);
      let key: CryptoKey | null = null;

      if (secrets.length > 0) {
        if (!environment.salt) return { error: 'This environment has no salt.' };
        if (passphrase === '') {
          return { error: 'Enter the passphrase to use this environment.' };
        }
        key = await deriveKey(passphrase, environment.salt);
      }

      for (const variable of environment.variables) {
        if (!variable.secret) {
          out[variable.name] = variable.value;
          continue;
        }
        if (!key) continue;
        const plain = await decryptSecret(key, variable.value);
        if (plain === null) {
          return { error: `Could not decrypt "${variable.name}". Wrong passphrase?` };
        }
        out[variable.name] = plain;
      }
      return out;
    },
    [collections, environment, passphrase, spec.id],
  );

  /*
   * The resolution report never decrypts anything: it reads the stored
   * variable list, so a secret is reported as present and measured rather than
   * previewed. Nothing here needs the passphrase.
   */
  const owningCollection = useMemo(
    () =>
      collections.find((collection) =>
        collection.requests.some((request) => request.id === spec.id),
      ) ?? null,
    [collections, spec.id],
  );

  /*
   * A GraphQL endpoint answers a failed query with HTTP 200 and an errors
   * array, so the status line alone reports success for a request that
   * returned nothing. This is what surfaces that.
   */
  /*
   * The link hint is read on every summary rather than cached: it changes when
   * the device moves between networks, and the API offers no event worth
   * subscribing to for this.
   */
  const networkHealth = useMemo(
    () =>
      summariseNetwork(
        netSamples,
        typeof navigator === 'undefined' ? null : readLinkInfo(navigator),
      ),
    [netSamples],
  );

  const graphQLResult = useMemo(
    () => (result?.body ? summariseGraphQLResult(result.body) : null),
    [result?.body],
  );

  const placeholderReport = useMemo(
    () =>
      reportPlaceholders(
        /*
         * Only the parts the relay substitutes. Scanning the scripts too
         * reported every {{name}} written in a comment as a missing variable,
         * which is noise: script text is executed, not substituted.
         */
        {
          url: [spec.url],
          header: spec.headers
            .filter((pair) => pair.enabled)
            .map((pair) => `${pair.name} ${pair.value}`),
          body: [spec.body],
        },
        layerVariables({
          collection: owningCollection?.variables ?? [],
          environment: environment?.variables ?? [],
        }),
        { scriptAssigned: findScriptAssignments(spec.preRequestScript) },
      ),
    [owningCollection, environment, spec],
  );

  const executeRequest = useCallback(
    async (
      overrides: Parameters<ExecuteRequest>[0] = {},
    ): Promise<RelayResult> => {
      const resolved = await resolveVariables(null);
      if ('error' in resolved) throw new Error(resolved.error);

      const headers: Record<string, string> = {};
      if (!overrides.replaceHeaders) {
        for (const pair of spec.headers) {
          if (!pair.enabled || pair.name.trim() === '') continue;
          headers[pair.name.trim().toLowerCase()] = pair.value;
        }
      }
      for (const [name, value] of Object.entries(overrides.headers ?? {})) {
        headers[name.toLowerCase()] = value;
      }

      const url = spec.url;
      const startedAt = performance.now();
      const response = await fetch('/api/relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          method: overrides.method ?? spec.method,
          headers,
          body: overrides.body ?? spec.body,
          script: overrides.script ?? spec.preRequestScript,
          tests: overrides.tests ?? spec.testScript,
          variables: resolved,
          ...(spec.auth && spec.auth.kind !== 'none' ? { auth: spec.auth } : {}),
          // The jar decides what applies to this URL; the relay just forwards
          // the header it produced.
          ...(cookieHeaderFor(jar, url) !== ''
            ? { cookie: cookieHeaderFor(jar, url) }
            : {}),
        }),
      });
      const result = (await response.json()) as RelayResult;

      if (Array.isArray(result.setCookies) && result.setCookies.length > 0) {
        setJar((current) => pruneJar(applySetCookies(current, result.setCookies ?? [], url)));
      }

      /*
       * One timing per relay call: what the browser measured end to end, and
       * what the relay says the target took. The difference is this app's own
       * cost, which is the number that answers "is it slow because of Relay?".
       */
      const totalMs = performance.now() - startedAt;
      setNetSamples((current) =>
        recordSample(current, {
          at: Date.now(),
          totalMs,
          upstreamMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
          bytes: typeof result.bodyBytes === 'number' ? result.bodyBytes : 0,
          ok: result.ok === true,
        }),
      );

      return result;
    },
    [jar, resolveVariables, spec],
  );

  const send = useCallback(async () => {
    setSending(true);
    setResult(null);
    setNotice(null);

    try {
      const payload = await executeRequest();
      setResult(payload);
      // Land on failures when there are any: that is why a test suite exists.
      setResponseTab(
        payload.assertions && (payload.assertions.failed ?? 0) > 0
          ? 'tests'
          : 'body',
      );

      /*
       * Recorded after the fact, and never allowed to break a send: history is
       * a convenience, so a browser with storage blocked or a quota already
       * spent simply has none.
       */
      const stored = await recordHistory({
        requestId: spec.id,
        name: spec.name,
        method: spec.method,
        url: spec.url,
        status: payload.status ?? null,
        ok: payload.ok === true,
        blocked: payload.reason === 'blocked',
        durationMs: payload.durationMs ?? 0,
        bodyBytes: payload.bodyBytes ?? 0,
        body: payload.body ?? '',
        headers: payload.headers ?? {},
        assertions: payload.assertions
          ? {
              passed: payload.assertions.passed ?? 0,
              failed: payload.assertions.failed ?? 0,
            }
          : null,
      });
      if (stored) setHistory((current) => [stored, ...current].slice(0, 100));
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'Request failed',
        tone: 'bad',
      });
    } finally {
      setSending(false);
    }
  }, [executeRequest, spec.id, spec.method, spec.name, spec.url]);

  // History is read once, after the workspace, so the first paint is not
  // waiting on IndexedDB.
  useEffect(() => {
    if (workspaceLoading) return;
    void listHistory().then(setHistory);
  }, [workspaceLoading]);

  /** Introspection is a normal relayed POST, with the schema query as its body. */
  const introspectGraphQL = useCallback(
    async (body: string): Promise<string> => {
      const payload = await executeRequest({
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
        script: '',
        tests: '',
      });
      if (payload.ok !== true) {
        throw new Error(payload.error ?? payload.reason ?? 'The request was refused');
      }
      return payload.body ?? '';
    },
    [executeRequest],
  );

  const signOut = useCallback(async () => {
    await fetch('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'signout' }),
    });
    onSignedOut();
  }, [onSignedOut]);

  /*
   * Generated code describes a request someone will run outside this app, so
   * it has to contain real values: a snippet with {{base_url}} in the URL is
   * not runnable anywhere, and pasting it into a terminal fails for a reason
   * that has nothing to do with the API being tested.
   *
   * Resolution happens the same way a send does — collection variables, then
   * the environment, with secrets decrypted here in the browser — so the
   * snippet and the request agree.
   */
  const [codeVariables, setCodeVariables] = useState<Record<string, string>>({});
  const [codeVariableError, setCodeVariableError] = useState<string | null>(null);

  useEffect(() => {
    if (requestTab !== 'code' || !codeResolve) return;
    let live = true;
    void resolveVariables(null).then((resolved) => {
      if (!live) return;
      if ('error' in resolved) {
        setCodeVariables({});
        setCodeVariableError(resolved.error);
        return;
      }
      setCodeVariables(resolved);
      setCodeVariableError(null);
    });
    return () => {
      live = false;
    };
  }, [requestTab, codeResolve, resolveVariables]);

  const codeRequest = useMemo(() => {
    /*
     * The exact request the relay last sent, headers and all. This is the only
     * way a snippet can carry a SigV4 signature or an OAuth2 access token,
     * because those are produced on the server at send time.
     */
    if (codeFromSent && result?.sent) {
      return {
        method: result.sent.method,
        url: result.sent.url,
        headers: Object.entries(result.sent.headers).map(([name, value]) => ({
          name,
          value,
          enabled: true,
        })),
        body: result.sent.body,
      };
    }

    const resolve = (value: string): string =>
      codeResolve ? substitute(value, codeVariables) : value;

    const headers = spec.headers
      .filter((pair) => pair.enabled && pair.name.trim() !== '')
      .map((pair) => ({
        name: pair.name.trim(),
        value: resolve(pair.value),
        enabled: true,
      }));

    const authHeader = staticAuthHeader(spec.auth, resolve);
    if (authHeader && !headers.some((pair) => pair.name.toLowerCase() === 'authorization')) {
      headers.push({ ...authHeader, enabled: true });
    }

    return {
      method: spec.method,
      url: resolve(spec.url),
      headers,
      body: resolve(spec.body),
    };
  }, [codeFromSent, result?.sent, codeResolve, codeVariables, spec]);

  const code = useMemo(
    () => generateCode(codeTarget, codeRequest),
    [codeTarget, codeRequest],
  );

  /** What the snippet cannot tell you by itself. */
  const codeNotes = useMemo(() => {
    const notes: string[] = [];
    if (codeFromSent) return notes;

    if (codeVariableError) notes.push(codeVariableError);

    /*
     * Read off the snippet itself rather than the resolution report, because
     * they disagree for a good reason: a variable a pre-request script assigns
     * counts as resolved for a send — the script runs on the way out — but
     * nothing can fill it in here, so it is still written as a placeholder in
     * the code.
     */
    const leftover = [
      ...new Set([
        ...findPlaceholderNames(codeRequest.url),
        ...codeRequest.headers.flatMap((pair) => findPlaceholderNames(pair.value)),
        ...findPlaceholderNames(codeRequest.body),
      ]),
    ];
    if (leftover.length > 0) {
      notes.push(
        `Left as written: ${leftover
          .map((name) => `{{${name}}}`)
          .join(', ')} — unset, or computed by the pre-request script when you send. Send once and tick “exact last send” to capture the real value.`,
      );
    }

    const kind = spec.auth?.kind;
    if (kind === 'sigv4' || kind === 'oauth2') {
      notes.push(
        kind === 'sigv4'
          ? 'The AWS signature is computed by the relay when you send, over the exact URL and body, so it is not in this snippet. Send once, then tick “exact last send” to include the real headers.'
          : 'The OAuth2 access token is fetched by the relay when you send, so it is not in this snippet. Send once, then tick “exact last send” to include the real Authorization header.',
      );
    }

    if (codeResolve && placeholderReport.some((entry) => entry.secret && entry.resolved)) {
      notes.push(
        'This snippet contains a decrypted secret value. Treat it like a credential: it is no longer encrypted once pasted somewhere.',
      );
    }
    return notes;
  }, [
    codeFromSent,
    codeRequest,
    codeResolve,
    codeVariableError,
    placeholderReport,
    spec.auth?.kind,
  ]);

  const closeDialog = useCallback(() => {
    if (dialogBusy) return;
    setDialog(null);
    setDialogError(null);
  }, [dialogBusy]);

  const openDialog = useCallback((next: WorkbenchDialog) => {
    setDialogError(null);
    setDialog(next);
  }, []);

  const saveCollection = useCallback(async (collection: Collection) => {
    if (mode === 'guest') {
      setNotice({ text: 'Sign in to save changes to a workspace.', tone: 'bad' });
      onRequireSignIn();
      throw new Error('Sign in to save changes.');
    }
    const response = await fetch('/api/workspace', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'collection', value: collection }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(String(data.error ?? 'Could not save the collection'));
    }

    const saved = data.saved as Collection;
    setCollections((current) => {
      const exists = current.some((item) => item.id === saved.id);
      // Sorted the way the store sorts, so a collection created now sits
      // where it will sit after a reload rather than jumping once the
      // workspace is fetched again.
      return exists
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved].sort(compareCollections);
    });
    return saved;
  }, [mode, onRequireSignIn]);

  const importCollection = useCallback(
    async (imported: ImportResult) => {
      setDialogBusy(true);
      setDialogError(null);
      try {
        const stamp = Date.now();
        await saveCollection({
          id: `imported-${stamp}`,
          name: imported.name.slice(0, 120),
          requests: imported.requests.map((request, index) => ({
            ...request,
            id: `request-${stamp}-${index}`,
          })),
        });
        setDialog(null);
        setNotice({
          text: `Imported ${imported.requests.length} request${
            imported.requests.length === 1 ? '' : 's'
          } into ${imported.name}.`,
          tone: 'good',
        });
      } catch (error) {
        setDialogError(
          error instanceof Error ? error.message : 'Could not save the import',
        );
      } finally {
        setDialogBusy(false);
      }
    },
    [saveCollection],
  );

  const importCurl = useCallback((command: string) => {
    const parsed = parseCurl(command);
    if (!parsed.ok) {
      setDialogError(parsed.error);
      return;
    }

    setSpec((current) => ({
      ...current,
      id: 'scratch',
      name: 'Imported from cURL',
      method: parsed.request.method,
      url: parsed.request.url,
      // A pasted command is authoritative: its headers are used verbatim. The
      // defaults only fill in for a command that carried none.
      headers:
        parsed.request.headers.length > 0
          ? parsed.request.headers
          : defaultHeaders(parsed.request.method),
      body: parsed.request.body,
    }));
    setResult(null);
    setRequestTab('params');
    setDialog(null);
    setDialogError(null);
    setNotice(
      parsed.request.ignored.length > 0
        ? {
            text: `Imported. Unsupported options: ${parsed.request.ignored.join(', ')}`,
            tone: 'good',
          }
        : { text: 'Request imported from cURL.', tone: 'good' },
    );
  }, []);

  const createEnvironment = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setDialogError('Give the environment a name.');
      return;
    }

    setDialogBusy(true);
    setDialogError(null);
    const value: Environment = {
      id: `env-${Date.now()}`,
      name: trimmed,
      salt: null,
      variables: [],
    };

    try {
      const response = await fetch('/api/workspace', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'environment', value }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(String(data.error ?? 'Could not create the environment'));
      }

      setEnvironments((current) => [...current, value]);
      setActiveEnv(value.id);
      setDialog(null);
      setNotice({ text: `${trimmed} environment created.`, tone: 'good' });
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Could not create it.');
    } finally {
      setDialogBusy(false);
    }
  }, []);

  const createRequest = useCallback(
    async (input: NewRequestInput) => {
      const name = input.name.trim();
      const url = input.url.trim();
      if (!name) {
        setDialogError('Give the request a name.');
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        setDialogError('Use a full http:// or https:// URL.');
        return;
      }

      setDialogBusy(true);
      setDialogError(null);
      const request: RequestSpec = {
        id: `request-${Date.now()}`,
        name,
        method: input.method,
        url,
        headers: defaultHeaders(input.method),
        body: '',
        bodyMode: defaultBodyMode(input.method),
        preRequestScript: '',
        testScript: '',
      };
      const target: Collection = collections[0] ?? {
        id: 'my-requests',
        name: 'My requests',
        requests: [],
      };

      try {
        await saveCollection({
          ...target,
          requests: [...target.requests, request],
        });
        setSpec(request);
        setResult(null);
        setRequestTab('params');
        setDialog(null);
        setNotice({ text: `${name} created and saved.`, tone: 'good' });
      } catch (error) {
        setDialogError(error instanceof Error ? error.message : 'Could not save it.');
      } finally {
        setDialogBusy(false);
      }
    },
    [collections, saveCollection],
  );

  const saveCurrentRequest = useCallback(async () => {
    let target = collections.find((collection) =>
      collection.requests.some((request) => request.id === spec.id),
    );
    target ??= collections[0];

    const savedSpec: RequestSpec =
      spec.id === 'scratch'
        ? { ...spec, id: `request-${Date.now()}` }
        : spec;
    const base: Collection = target ?? {
      id: 'my-requests',
      name: 'My requests',
      requests: [],
    };
    const exists = base.requests.some((request) => request.id === savedSpec.id);

    try {
      await saveCollection({
        ...base,
        requests: exists
          ? base.requests.map((request) =>
              request.id === savedSpec.id ? savedSpec : request,
            )
          : [...base.requests, savedSpec],
      });
      /*
       * Writing the saved copy back over the editor would discard anything
       * typed while the request was in flight: the save persists the spec as
       * it looked when you pressed save, and the PUT can take a while, so a
       * blind `setSpec(savedSpec)` silently reverted later keystrokes.
       *
       * Only the generated id needs adopting, and only for a scratch request
       * that is still the one on screen. An already-identified request needs
       * no editor change at all.
       */
      if (spec.id === 'scratch') {
        setOpenRequests((current) =>
          current.filter((request) => request.id !== 'scratch'),
        );
        setSpec((current) =>
          current.id === 'scratch' ? { ...current, id: savedSpec.id } : current,
        );
      }
      setNotice({ text: `${savedSpec.name} saved.`, tone: 'good' });
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'Could not save the request.',
        tone: 'bad',
      });
    }
  }, [collections, saveCollection, spec]);

  const createCollection = useCallback(
    async (rawName: string) => {
      const name = rawName.trim();
      if (!name) {
        setDialogError('Give the collection a name.');
        return;
      }

      setDialogBusy(true);
      setDialogError(null);
      try {
        await saveCollection({
          id: `collection-${Date.now()}`,
          name,
          requests: [],
        });
        setDialog(null);
        setNotice({ text: `${name} collection created.`, tone: 'good' });
      } catch (error) {
        setDialogError(
          error instanceof Error ? error.message : 'Could not create it.',
        );
      } finally {
        setDialogBusy(false);
      }
    },
    [saveCollection],
  );

  /** Opens the rename or delete dialog for one request. */
  const askAboutRequest = useCallback(
    (request: RequestSpec, which: 'rename-request' | 'delete-request') => {
      setRequestTarget(request);
      setDialogError(null);
      setDialog(which);
    },
    [],
  );

  const renameRequest = useCallback(
    async (rawName: string) => {
      const request = requestTarget;
      if (!request) return;
      const name = rawName.trim();
      if (name === '') {
        setDialogError('Give the request a name.');
        return;
      }
      if (name === request.name) {
        setDialog(null);
        return;
      }

      const owner = collections.find((collection) =>
        collection.requests.some((candidate) => candidate.id === request.id),
      );
      if (!owner) {
        setDialogError('That request is no longer in the workspace.');
        return;
      }

      setDialogBusy(true);
      setDialogError(null);
      try {
        await saveCollection({
          ...owner,
          requests: owner.requests.map((candidate) =>
            candidate.id === request.id ? { ...candidate, name } : candidate,
          ),
        });
        // Keep the open tab and the active editor label in step with the rename.
        setOpenRequests((current) =>
          current.map((candidate) =>
            candidate.id === request.id ? { ...candidate, name } : candidate,
          ),
        );
        setSpec((current) =>
          current.id === request.id ? { ...current, name } : current,
        );
        setDialog(null);
        setNotice({ text: `Renamed to ${name}.`, tone: 'good' });
      } catch (error) {
        setDialogError(
          error instanceof Error ? error.message : 'Could not rename it.',
        );
      } finally {
        setDialogBusy(false);
      }
    },
    [collections, requestTarget, saveCollection],
  );

  const deleteRequest = useCallback(async () => {
    const request = requestTarget;
    if (!request) return;
    const owner = collections.find((collection) =>
      collection.requests.some((candidate) => candidate.id === request.id),
    );
    if (!owner) {
      setDialogError('That request is no longer in the workspace.');
      return;
    }

    setDialogBusy(true);
    setDialogError(null);
    try {
      await saveCollection({
        ...owner,
        requests: owner.requests.filter((candidate) => candidate.id !== request.id),
      });
      setOpenRequests((current) =>
        current.filter((candidate) => candidate.id !== request.id),
      );
      setSpec((current) => (current.id === request.id ? BLANK : current));
      if (spec.id === request.id) setResult(null);
      setDialog(null);
      setNotice({ text: `Deleted ${request.name}.`, tone: 'good' });
    } catch (error) {
      setDialogError(
        error instanceof Error ? error.message : 'Could not delete it.',
      );
    } finally {
      setDialogBusy(false);
    }
  }, [collections, requestTarget, saveCollection, spec.id]);

  /*
   * Reordering, and moving a request from one collection to another.
   *
   * The sidebar is updated before the writes so the drop lands where the
   * pointer released it, then the affected collections are persisted. A
   * cross-collection move is two writes: the destination goes first, because
   * if the second fails the request still exists in both places and a resync
   * restores the truth, whereas the other order could lose it entirely.
   */
  const moveRequest = useCallback(
    async ({ requestId, from, to, beforeId }: RequestMove) => {
      const source = collections.find((collection) => collection.id === from);
      const destination = collections.find((collection) => collection.id === to);
      const moving = source?.requests.find((request) => request.id === requestId);
      if (!source || !destination || !moving) return;

      const without = destination.requests.filter(
        (request) => request.id !== requestId,
      );
      const at = beforeId
        ? without.findIndex((request) => request.id === beforeId)
        : -1;
      const nextRequests =
        at >= 0
          ? [...without.slice(0, at), moving, ...without.slice(at)]
          : [...without, moving];

      const sameOrder =
        from === to &&
        nextRequests.length === destination.requests.length &&
        nextRequests.every(
          (request, index) => request.id === destination.requests[index]?.id,
        );
      if (sameOrder) return;

      const updates: Collection[] =
        from === to
          ? [{ ...destination, requests: nextRequests }]
          : [
              { ...destination, requests: nextRequests },
              {
                ...source,
                requests: source.requests.filter(
                  (request) => request.id !== requestId,
                ),
              },
            ];

      const previous = collections;
      setCollections((current) =>
        current.map(
          (collection) =>
            updates.find((update) => update.id === collection.id) ?? collection,
        ),
      );

      try {
        for (const update of updates) await saveCollection(update);
        if (from !== to) {
          setNotice({
            text: `Moved ${moving.name} to ${destination.name}.`,
            tone: 'good',
          });
        }
      } catch (error) {
        setCollections(previous);
        setNotice({
          text: error instanceof Error ? error.message : 'Could not move it.',
          tone: 'bad',
        });
        // The optimistic order is gone either way; take the server's.
        await loadWorkspace().catch(() => {});
      }
    },
    [collections, loadWorkspace, saveCollection],
  );

  const generateTests = useCallback(() => {
    if (!result?.ok) {
      setNotice({ text: 'Send the request first, then generate tests.', tone: 'bad' });
      return;
    }
    const generated = generateAssertions({
      status: result.status ?? 0,
      statusText: result.statusText,
      headers: result.headers,
      body: result.body,
      durationMs: result.durationMs,
    });
    // Append to an existing suite rather than discarding hand-written tests.
    setSpec((current) => ({
      ...current,
      testScript:
        current.testScript.trim() === ''
          ? generated
          : `${current.testScript.trimEnd()}\n\n${generated}`,
    }));
    setRequestTab('tests');
    setNotice({ text: 'Generated tests from the last response.', tone: 'good' });
  }, [result]);

  /*
   * Editor shortcuts. Only Save and Send are intercepted — and only with a
   * modifier — so native cut/copy/paste/undo/redo in every input keep working.
   * The listener is on the window so Ctrl/Cmd+S saves the request instead of
   * opening the browser's save dialog, even while a field is focused.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void saveCurrentRequest();
      } else if (key === 'enter') {
        event.preventDefault();
        void send();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveCurrentRequest, send]);

  const addSecret = useCallback(
    async (input: NewSecretInput) => {
      if (!environment) {
        setDialogError('Choose an environment first.');
        return;
      }
      const name = input.name.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        setDialogError('Use letters, numbers and underscores; start with a letter.');
        return;
      }
      if (input.passphrase.length < 8) {
        setDialogError('Use a passphrase of at least 8 characters.');
        return;
      }

      setDialogBusy(true);
      setDialogError(null);
      try {
        const salt = environment.salt ?? createSalt();
        const key = await deriveKey(input.passphrase, salt);
        const next: Environment = {
          ...environment,
          salt,
          variables: [
            ...environment.variables.filter((variable) => variable.name !== name),
            {
              name,
              value: await encryptSecret(key, input.value),
              secret: true,
            },
          ],
        };

        const response = await fetch('/api/workspace', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'environment', value: next }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(String(data.error ?? 'Could not save the secret'));
        }

        setPassphrase(input.passphrase);
        setEnvironments((current) =>
          current.map((candidate) => (candidate.id === next.id ? next : candidate)),
        );
        setDialog(null);
        setNotice({
          text: `${name} encrypted and saved.`,
          tone: 'good',
        });
      } catch (error) {
        setDialogError(error instanceof Error ? error.message : 'Could not save it.');
      } finally {
        setDialogBusy(false);
      }
    },
    [environment],
  );

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: 'send', label: 'Send request', hint: 'Enter', run: () => void send() },
      {
        id: 'new-request',
        label: 'Create a new request',
        hint: 'N',
        run: () => openDialog('new-request'),
      },
      {
        id: 'save',
        label: 'Save current request',
        hint: 'S',
        run: () => void saveCurrentRequest(),
      },
      {
        id: 'import',
        label: 'Import from cURL',
        run: () => openDialog('import-curl'),
      },
      {
        id: 'new-collection',
        label: 'Create a new collection',
        run: () => openDialog('new-collection'),
      },
      {
        id: 'settings',
        label: 'Open settings',
        hint: 'account',
        run: () => setSettingsOpen(true),
      },
      {
        id: 'tour',
        label: 'Take the guided tour',
        run: () => setTourOpen(true),
      },
      {
        id: 'import-api',
        label: 'Import OpenAPI or Postman',
        run: () => setImportOpen(true),
      },
      {
        id: 'run-collection',
        label: 'Run a collection',
        run: () => setRunnerCollectionId(collections[0]?.id ?? null),
      },
      { id: 'code', label: 'Generate client code', run: () => setRequestTab('code') },
      { id: 'tests', label: 'Edit response tests', run: () => setRequestTab('tests') },
      {
        id: 'traffic',
        label: 'Run repeated traffic test',
        hint: '50 max',
        run: () => setRequestTab('traffic'),
      },
      {
        id: 'security',
        label: 'Audit target security posture',
        hint: '2 probes',
        run: () => setRequestTab('security'),
      },
      {
        id: 'report',
        label: 'Run full vulnerability & analysis report',
        hint: 'one click',
        run: () => setRequestTab('report'),
      },
      {
        id: 'theme',
        label: 'Toggle theme',
        run: () => {
          const next =
            document.documentElement.getAttribute('data-theme') === 'dark'
              ? 'light'
              : 'dark';
          document.documentElement.setAttribute('data-theme', next);
          localStorage.setItem('wac-theme', next);
        },
      },
    ];

    for (const collection of collections) {
      for (const request of collection.requests) {
        list.push({
          id: `open-${request.id}`,
          label: request.name,
          hint: request.method,
          run: () => {
            openRequest(request);
          },
        });
      }
    }
    return list;
  }, [collections, openDialog, openRequest, saveCurrentRequest, send]);

  const headerHint = useMemo(() => {
    for (const pair of spec.headers) {
      const match = findHeader(pair.name);
      if (match) return match;
    }
    return undefined;
  }, [spec.headers]);



  if (workspaceLoading) {
    return (
      <BootScreen
        title="Opening your workspace"
        message="Loading collections, environments and encrypted variables…"
      />
    );
  }

  return (
    <>
      <WorkbenchDialogs
        active={dialog}
        environmentName={environment?.name ?? null}
        initialPassphrase={passphrase}
        busy={dialogBusy}
        error={dialogError}
        requestTarget={requestTarget}
        onClose={closeDialog}
        onImportCurl={importCurl}
        onCreateCollection={createCollection}
        onCreateEnvironment={createEnvironment}
        onCreateRequest={createRequest}
        onCreateSecret={addSecret}
        onRenameRequest={renameRequest}
        onDeleteRequest={deleteRequest}
        canPersist={mode !== 'guest'}
      />
      <CommandPalette commands={commands} />

      <SettingsPanel
        open={settingsOpen}
        email={email}
        mode={mode}
        onClose={() => setSettingsOpen(false)}
        onAccountChanged={() => onAccountChanged?.()}
        onStartTour={() => setTourOpen(true)}
        onSignIn={() => {
          setSettingsOpen(false);
          onRequireSignIn();
        }}
      />

      <MfaSetupDialog
        open={mfaOfferOpen}
        offerSkip
        onClose={() => setMfaOfferOpen(false)}
        onSkip={async () => {
          await fetch('/api/account', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'mfa-skip' }),
          }).catch(() => undefined);
          await onAccountChanged?.();
        }}
        onEnabled={async () => {
          setNotice({ text: 'Two-factor authentication is on.', tone: 'good' });
          await onAccountChanged?.();
        }}
      />

      <ImportDialog
        open={importOpen}
        busy={dialogBusy}
        error={dialogError}
        onClose={() => {
          if (dialogBusy) return;
          setImportOpen(false);
          setDialogError(null);
        }}
        onImport={async (imported) => {
          await importCollection(imported);
          setImportOpen(false);
        }}
      />

      <CollectionRunner
        open={runnerCollectionId !== null}
        collection={
          collections.find((collection) => collection.id === runnerCollectionId) ?? null
        }
        canPersist={mode !== 'guest'}
        getVariables={() =>
          resolveVariables(
            collections.find((collection) => collection.id === runnerCollectionId) ??
              null,
          )
        }
        onClose={() => setRunnerCollectionId(null)}
        onSaveVariables={async (variables) => {
          const target = collections.find(
            (collection) => collection.id === runnerCollectionId,
          );
          if (!target) return;
          await saveCollection({ ...target, variables });
          setNotice({ text: `${target.name} variables saved.`, tone: 'good' });
        }}
      />

      <Tour
        open={tourOpen}
        steps={TOUR_STEPS}
        audience={guest ? 'guest' : 'account'}
        onFinish={() => void closeTour()}
        onSkip={() => void closeTour()}
      />

      <div className="topbar">
        <span className="brand">
          <Logo />
          <h1>Relay</h1>
        </span>

        <button
          type="button"
          className="commandTrigger"
          data-tour="palette"
          aria-keyshortcuts="Control+K Meta+K"
          title="Command palette · Ctrl/Cmd+K"
          onClick={() => window.dispatchEvent(new Event('wac:open-palette'))}
        >
          <span>Search requests and actions</span>
          <span className="kbd">Ctrl K</span>
        </button>

        <div className="topbarActions">
          <select
            className="environmentSelect"
            data-tour="environment"
            aria-label="Environment"
            value={activeEnv}
            onChange={(event) => setActiveEnv(event.target.value)}
          >
            <option value="">No environment</option>
            {environments.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => openDialog('import-curl')}>
            Import cURL
          </button>
          <button type="button" onClick={() => setImportOpen(true)}>
            Import API
          </button>
          <button type="button" onClick={() => openDialog('new-environment')}>
            New environment
          </button>
          <NetworkChip health={networkHealth} />
          <PwaInstall />
          <ThemeToggle />
          <button
            type="button"
            className="ghost settingsButton"
            data-tour="settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <span aria-hidden="true">⚙</span>
            <span>Settings</span>
          </button>
          {mode === 'accounts' ? (
            <>
              <span className="userChip" title={email}>
                <span className="userAvatar" aria-hidden="true">
                  {email.slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate">{email}</span>
                {account?.mfaEnabled ? (
                  <span className="userShield" title="Two-factor is on" aria-label="Two-factor authentication is on">
                    🛡
                  </span>
                ) : null}
              </span>
              <button type="button" className="ghost" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : mode === 'guest' ? (
            <>
              <span className="guestChip">Guest · changes are not saved</span>
              <button type="button" className="primary compact" onClick={onRequireSignIn}>
                Sign in to save
              </button>
            </>
          ) : (
            <span className="badge warn">
              {mode === 'degraded' ? 'Database offline · local fallback' : 'local mode'}
            </span>
          )}
        </div>
      </div>

      <div className="shell">
        {/* ---------------- sidebar ---------------- */}
        <aside className="pane scroll" data-tour="sidebar">
          <div className="paneHead sidebarHead">
            <h2>Collections</h2>
            <button
              type="button"
              className="sidebarAdd"
              aria-label="Create request"
              title="Create request"
              onClick={() => openDialog('new-request')}
            >
              +
            </button>
          </div>

          {collections.length === 0 ? (
            <div className="sidebarEmpty">
              <strong>No requests yet</strong>
              <span>Create one or import a cURL command.</span>
              <button type="button" onClick={() => openDialog('new-request')}>
                New request
              </button>
            </div>
          ) : (
            <RequestList
              collections={collections}
              activeId={spec.id}
              onOpen={openRequest}
              onRename={(request) => askAboutRequest(request, 'rename-request')}
              onDelete={(request) => askAboutRequest(request, 'delete-request')}
              onMove={(move) => void moveRequest(move)}
              onRun={(collection) => setRunnerCollectionId(collection.id)}
            />
          )}

          <button
            type="button"
            className="sidebarNewCollection"
            onClick={() => openDialog('new-collection')}
          >
            + New collection
          </button>

          <div className="paneHead sidebarHead environmentHead">
            <h2>Environment</h2>
            <button
              type="button"
              className="sidebarAdd"
              aria-label="Create environment"
              title="Create environment"
              onClick={() => openDialog('new-environment')}
            >
              +
            </button>
          </div>
          {environment ? (
            <>
              <div className="field">
                <label htmlFor="passphrase">Passphrase</label>
                <PasswordField
                  id="passphrase"
                  autoComplete="off"
                  value={passphrase}
                  placeholder="never sent to the server"
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </div>
              <button type="button" onClick={() => openDialog('new-secret')}>
                Add encrypted secret
              </button>
              <ul className="hops">
                {environment.variables.map((variable) => (
                  <li key={variable.name}>
                    {variable.secret ? '🔒' : '·'} {variable.name}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="notice">
              Select an environment to use <code>{'{{variables}}'}</code>.
              Secrets are encrypted in this browser before being saved.
            </p>
          )}
        </aside>

        {/* ---------------- request ---------------- */}
        <section className="pane scroll requestPane">
          <RequestTabs
            requests={openRequests}
            activeId={spec.id}
            onSelect={openRequest}
            onClose={closeRequest}
            onCreate={() => openDialog('new-request')}
          />

          <div className="requestHeading">
            <div className="requestIdentity">
              <span className={`verb verb-${spec.method}`}>{spec.method}</span>
              <strong className="truncate">{spec.name}</strong>
            </div>
            <div className="row">
              <button
                type="button"
                aria-keyshortcuts="Control+S Meta+S"
                title={mode === 'guest' ? 'Sign in to save · Ctrl/Cmd+S' : 'Save · Ctrl/Cmd+S'}
                onClick={() => void saveCurrentRequest()}
              >
                Save
              </button>
              <button type="button" onClick={() => setRequestTab('code')}>
                Generate code
              </button>
            </div>
          </div>

          <div className="requestBar" data-tour="request-bar">
            <select
              className="methodSelect"
              aria-label="Method"
              value={spec.method}
              onChange={(event) => patch({ method: event.target.value })}
            >
              {HTTP_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
            <span className="requestUrlField">
              <span className="urlProtocolMark" aria-hidden="true">
                →
              </span>
              <input
                className="requestUrl"
                aria-label="Request URL"
                value={spec.url}
                placeholder="https://api.example.com/v1/resources"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && spec.url.trim() !== '') {
                    event.preventDefault();
                    void send();
                  }
                }}
                onChange={(event) => patch({ url: event.target.value })}
              />
            </span>
            <button
              type="button"
              className="primary sendButton"
              data-tour="send"
              aria-keyshortcuts="Control+Enter Meta+Enter"
              title="Send · Ctrl/Cmd+Enter"
              onClick={send}
              disabled={sending || spec.url.trim() === ''}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>

          <div
            className="tabs"
            role="tablist"
            aria-label="Request detail"
            data-tour="request-tabs"
          >
            {(
              [
                ['params', `Params`, query.pairs.length],
                ['headers', 'Headers', spec.headers.filter((h) => h.name).length],
                // What the last send actually put on the wire, beside what is
                // composed here: substituted, with server-applied auth.
                ['sent', 'Sent', result?.sent ? 1 : 0],
                ['auth', 'Auth', spec.auth && spec.auth.kind !== 'none' ? 1 : 0],
                ['body', 'Body', spec.body.trim() === '' ? 0 : 1],
                ['graphql', 'GraphQL', spec.body.includes('"query"') ? 1 : 0],
                ['cookies', 'Cookies', jar.length],
                ['stream', 'Stream', 0],
                [
                  'vars',
                  'Vars',
                  placeholderReport.filter((entry) => !entry.resolved).length,
                ],
                ['script', 'Pre-run', spec.preRequestScript.trim() === '' ? 0 : 1],
                [
                  'tests',
                  'Tests',
                  (spec.testScript.trim() === '' ? 0 : 1) +
                    (spec.captures?.length ?? 0),
                ],
                ['traffic', 'Traffic', 0],
                ['security', 'Security', 0],
                ['report', 'Report', 0],
                ['assist', 'Assist', 0],
                ['code', 'Code', 0],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="tab"
                // Anchors the tour on individual tabs, which is the only way a
                // step can point at the feature it is describing.
                data-tour={`tab-${id}`}
                aria-selected={requestTab === id}
                onClick={() => setRequestTab(id)}
              >
                {label}
                {count > 0 ? <span className="count">{count}</span> : null}
              </button>
            ))}
          </div>

          {requestTab === 'params' ? (
            <>
              {query.pairs.length === 0 ? (
                <p className="hint">
                  Add <code>?key=value</code> to the URL and the pairs appear here.
                </p>
              ) : null}
              {query.pairs.map((pair, index) => (
                <div className="kvRow" key={index}>
                  <input
                    type="checkbox"
                    aria-label={`Enable param ${index + 1}`}
                    checked={pair.enabled}
                    onChange={(event) =>
                      setQueryPair(index, { enabled: event.target.checked })
                    }
                  />
                  <input
                    aria-label={`Param ${index + 1} name`}
                    value={pair.name}
                    onChange={(event) => setQueryPair(index, { name: event.target.value })}
                  />
                  <input
                    aria-label={`Param ${index + 1} value`}
                    value={pair.value}
                    onChange={(event) =>
                      setQueryPair(index, { value: event.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="iconBtn"
                    aria-label={`Remove param ${index + 1}`}
                    onClick={() =>
                      patch({
                        url: writeQuery(
                          query.base,
                          query.pairs.filter((_, i) => i !== index),
                        ),
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  patch({
                    url: writeQuery(query.base, [
                      ...query.pairs,
                      { name: 'key', value: 'value', enabled: true },
                    ]),
                  })
                }
              >
                Add param
              </button>
            </>
          ) : null}

          {requestTab === 'headers' ? (
            <>
              {/* A native datalist gives filtering, keyboard handling, and
                  screen-reader support that a custom dropdown would have to
                  reimplement and usually gets wrong. */}
              <datalist id="header-names">
                {COMMON_HEADERS.map((header) => (
                  <option key={header.name} value={header.name}>
                    {header.hint}
                  </option>
                ))}
              </datalist>

              {spec.headers.map((pair, index) => {
                const known = findHeader(pair.name);
                const listId = known?.values ? `hv-${index}` : undefined;
                return (
                  <div className="kvRow" key={index}>
                    <input
                      type="checkbox"
                      aria-label={`Enable header ${index + 1}`}
                      checked={pair.enabled}
                      onChange={(event) =>
                        setHeader(index, { enabled: event.target.checked })
                      }
                    />
                    <input
                      aria-label={`Header ${index + 1} name`}
                      list="header-names"
                      value={pair.name}
                      placeholder="content-type"
                      onChange={(event) => setHeader(index, { name: event.target.value })}
                    />
                    <span>
                      <input
                        aria-label={`Header ${index + 1} value`}
                        list={listId}
                        value={pair.value}
                        placeholder={known?.values?.[0] ?? 'value'}
                        onChange={(event) =>
                          setHeader(index, { value: event.target.value })
                        }
                      />
                      {known?.values ? (
                        <datalist id={listId}>
                          {known.values.map((value) => (
                            <option key={value} value={value} />
                          ))}
                        </datalist>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      className="iconBtn"
                      aria-label={`Remove header ${index + 1}`}
                      onClick={() =>
                        patch({ headers: spec.headers.filter((_, i) => i !== index) })
                      }
                    >
                      ×
                    </button>
                  </div>
                );
              })}

              {headerHint ? <p className="hint">{headerHint.hint}</p> : null}

              <button
                type="button"
                onClick={() =>
                  patch({
                    headers: [...spec.headers, { name: '', value: '', enabled: true }],
                  })
                }
              >
                Add header
              </button>
            </>
          ) : null}

          {requestTab === 'body' ? (
            <div className="bodyEditor">
              <div className="bodyToolbar">
                <div className="bodyModes" role="group" aria-label="Body format">
                  {CONTENT_TYPE_PRESETS.map((preset) => {
                    const selected = preset.id === activeContentType;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className="bodyMode"
                        data-active={selected}
                        aria-pressed={selected}
                        onClick={() => switchBodyMode(preset.id)}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                {activeContentType !== 'none' ? (
                  <div className="bodyTools">
                    <button type="button" onClick={() => applyBodyFormat(false)}>
                      Format
                    </button>
                    <button type="button" onClick={() => applyBodyFormat(true)}>
                      Minify
                    </button>
                  </div>
                ) : null}
              </div>

              {bodyFormatError ? <p className="notice bad">{bodyFormatError}</p> : null}

              {activeContentType === 'none' ? (
                <div className="bodyEmpty">
                  <strong>No request body</strong>
                  <p>Choose JSON, form, text, or XML. Each format keeps its own draft when you switch.</p>
                </div>
              ) : (
                <div className="field bodyField">
                  <label htmlFor="body">{CONTENT_TYPE_PRESETS.find((p) => p.id === activeContentType)?.label} body</label>
                  <textarea
                    id="body"
                    value={spec.body}
                    placeholder={CONTENT_TYPE_PRESETS.find((p) => p.id === activeContentType)?.sample}
                    onChange={(event) => {
                      const value = event.target.value;
                      patch({
                        body: value,
                        bodyMode: activeContentType,
                        bodyDrafts: {
                          ...(spec.bodyDrafts ?? {}),
                          [activeContentType]: value,
                        },
                      });
                    }}
                  />
                  <p className="hint">Draft preserved per format · <code>{'{{variables}}'}</code> substituted on send</p>
                </div>
              )}
            </div>
          ) : null}

          {requestTab === 'script' ? (
            <div className="field">
              <label htmlFor="script">Pre-request script</label>
              <textarea
                id="script"
                value={spec.preRequestScript}
                placeholder="vars.stamp = String(Date.now());"
                onChange={(event) => patch({ preRequestScript: event.target.value })}
              />
              <p className="hint">
                Runs in a WebAssembly sandbox with a 1s limit. No network, no
                filesystem, no host access. Assign to <code>vars</code> to fill{' '}
                <code>{'{{placeholders}}'}</code>.
              </p>
            </div>
          ) : null}

          {requestTab === 'vars' ? (
            <div className="field">
              <label style={{ margin: '0 0 0.4rem' }}>Variable resolution</label>
              <VariableReport reports={placeholderReport} />
            </div>
          ) : null}

          {requestTab === 'sent' ? (
            result?.sent ? (
              <SentRequestPanel sent={result.sent} />
            ) : (
              <p className="notice">
                Send the request and this shows exactly what left the proxy:
                the resolved URL, every header including the ones added for
                you, and the body.
              </p>
            )
          ) : null}

          {requestTab === 'auth' ? (
            <AuthEditor
              auth={spec.auth ?? { kind: 'none' }}
              onChange={(auth) => patch({ auth })}
            />
          ) : null}

          {requestTab === 'graphql' ? (
            <GraphQLEditor
              body={spec.body}
              onChange={(body) => {
                const headers = spec.headers.some(
                  (pair) => pair.name.trim().toLowerCase() === 'content-type',
                )
                  ? spec.headers
                  : [
                      { name: 'content-type', value: 'application/json', enabled: true },
                      ...spec.headers,
                    ];
                // A GraphQL request is a POST with a JSON body, so the method
                // and content type follow the editor rather than being left
                // for the user to remember.
                patch({
                  body,
                  headers,
                  bodyMode: 'json',
                  ...(spec.method === 'GET' ? { method: 'POST' } : {}),
                });
              }}
              onIntrospect={introspectGraphQL}
            />
          ) : null}

          {requestTab === 'stream' ? (
            <StreamPanel
              url={spec.url}
              method={spec.method}
              body={spec.body}
              headers={Object.fromEntries(
                spec.headers
                  .filter((pair) => pair.enabled && pair.name.trim() !== '')
                  .map((pair) => [pair.name.trim().toLowerCase(), pair.value]),
              )}
              getVariables={() => resolveVariables(null)}
            />
          ) : null}

          {requestTab === 'cookies' ? (
            <CookiePanel
              jar={jar}
              url={spec.url}
              onRemove={(name, domain, path) =>
                setJar((current) => removeCookie(current, name, domain, path))
              }
              onClear={() => setJar(EMPTY_JAR)}
            />
          ) : null}

          {requestTab === 'tests' ? (
            <div className="field">
              <label style={{ margin: '0 0 0.4rem' }}>Capture for later requests</label>
              <CaptureEditor
                captures={spec.captures ?? []}
                onChange={(captures) => patch({ captures })}
              />

              <div
                className="row"
                style={{ justifyContent: 'space-between', marginTop: '1.2rem' }}
              >
                <label htmlFor="tests" style={{ margin: 0 }}>
                  Assertions
                </label>
                <div className="row" style={{ gap: '0.4rem' }}>
                  <button
                    type="button"
                    className="chip"
                    data-active={Boolean(result?.ok)}
                    disabled={!result?.ok}
                    title={
                      result?.ok
                        ? 'Generate assertions from the last response'
                        : 'Send the request first'
                    }
                    onClick={generateTests}
                  >
                    Generate from response
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => patch({ testScript: SAMPLE_ASSERTIONS })}
                  >
                    Insert example
                  </button>
                </div>
              </div>
              <textarea
                id="tests"
                value={spec.testScript}
                placeholder={SAMPLE_ASSERTIONS}
                onChange={(event) => patch({ testScript: event.target.value })}
                style={{ marginTop: '0.4rem' }}
              />
              <p className="hint">
                Runs after the response in the same sandbox. Use{' '}
                <code>test(name, fn)</code> with <code>expect(...)</code>, and{' '}
                <code>response.status</code>, <code>response.json()</code>,{' '}
                <code>response.header(name)</code>, <code>response.durationMs</code>.
              </p>
            </div>
          ) : null}

          {requestTab === 'traffic' ? (
            <TrafficLab execute={executeRequest} />
          ) : null}

          {requestTab === 'security' ? (
            <SecurityLab url={spec.url} execute={executeRequest} />
          ) : null}

          {requestTab === 'report' ? (
            <VulnReport url={spec.url} execute={executeRequest} />
          ) : null}

          {requestTab === 'assist' ? (
            <AssistPanel
              spec={spec}
              result={result}
              onInsertTests={(code) => {
                setSpec((current) => ({
                  ...current,
                  testScript:
                    current.testScript.trim() === ''
                      ? `${code}\n`
                      : `${current.testScript.trimEnd()}\n\n${code}\n`,
                }));
                setRequestTab('tests');
                setNotice({ text: 'Inserted AI-suggested tests.', tone: 'good' });
              }}
            />
          ) : null}

          {requestTab === 'code' ? (
            <>
              <div className="row">
                <select
                  aria-label="Code target"
                  value={codeTarget}
                  onChange={(event) => setCodeTarget(event.target.value as CodeTarget)}
                >
                  {[...new Set(CODE_TARGETS.map((target) => target.group))].map(
                    (group) => (
                      <optgroup key={group} label={group}>
                        {CODE_TARGETS.filter((target) => target.group === group).map(
                          (target) => (
                            <option key={target.id} value={target.id}>
                              {target.label}
                            </option>
                          ),
                        )}
                      </optgroup>
                    ),
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(code);
                    setNotice({ text: 'Copied to clipboard.', tone: 'good' });
                  }}
                >
                  Copy
                </button>
              </div>
              <div className="codeOptions">
                <label>
                  <input
                    type="checkbox"
                    checked={codeResolve}
                    disabled={codeFromSent}
                    onChange={(event) => setCodeResolve(event.target.checked)}
                  />
                  Resolve <code>{'{{variables}}'}</code>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={codeFromSent}
                    disabled={!result?.sent}
                    onChange={(event) => setCodeFromSent(event.target.checked)}
                  />
                  Exact last send
                  {result?.sent ? null : <small> · send once to enable</small>}
                </label>
              </div>
              <pre style={{ marginTop: '0.6rem' }}>{code}</pre>
              {codeNotes.map((note) => (
                <p className="hint" key={note}>
                  {note}
                </p>
              ))}
              <p className="hint">
                Values are quoted for the target language, so a URL containing
                shell metacharacters cannot execute when you paste this.
              </p>
            </>
          ) : null}
        </section>

        {/* ---------------- response ---------------- */}
        <section className="pane scroll responsePane" data-tour="response">
          <div className="paneHead responseHeading">
            <h2>Response</h2>
            <span className="badge good">guarded relay</span>
          </div>

          {notice ? (
            <p className={`notice ${notice.tone}`}>{notice.text}</p>
          ) : null}
          {sending ? <p className="spinner">Waiting for the proxy…</p> : null}

          {result ? (
            <>
              <div className="statusLine">
                {result.ok ? (
                  <>
                    <strong className={statusClass(result.status)}>
                      {result.status} {result.statusText}
                    </strong>
                    <span
                      title="Target round trip as measured by the relay"
                    >
                      {result.durationMs} ms
                    </span>
                    <span>{result.bodyBytes} B</span>
                    {typeof result.quotaRemaining === 'number' ? (
                      <span>quota {result.quotaRemaining}</span>
                    ) : null}
                  </>
                ) : (
                  <strong className="codeErr">{result.reason ?? 'error'}</strong>
                )}
              </div>

              {!result.ok ? (
                <p className={`notice ${result.reason === 'blocked' ? 'bad' : 'warn'}`}>
                  {withStop(result.error)}
                  {explainRefusal(result.reason, result.cause)}
                </p>
              ) : null}

              {/* Copying a response was only possible by selecting it by
                  hand, which fails on a body long enough to scroll. */}
              <div className="responseActions">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(result.body ?? '');
                    setNotice({ text: 'Response body copied.', tone: 'good' });
                  }}
                >
                  Copy body
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(
                      Object.entries(result.headers ?? {})
                        .map(([name, value]) => `${name}: ${value}`)
                        .join('\n'),
                    );
                    setNotice({ text: 'Response headers copied.', tone: 'good' });
                  }}
                >
                  Copy headers
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Status line, headers and body: what you would paste into
                    // an issue to describe a response.
                    void navigator.clipboard.writeText(
                      [
                        `${result.status ?? ''} ${result.statusText ?? ''}`.trim(),
                        ...Object.entries(result.headers ?? {}).map(
                          ([name, value]) => `${name}: ${value}`,
                        ),
                        '',
                        result.body ?? '',
                      ].join('\n'),
                    );
                    setNotice({ text: 'Full response copied.', tone: 'good' });
                  }}
                >
                  Copy all
                </button>
              </div>

              <div className="tabs" role="tablist" aria-label="Response detail">
                {(
                  [
                    ['body', 'Body', ''],
                    ['headers', 'Headers', ''],
                    [
                      'tests',
                      'Tests',
                      result.assertions
                        ? `${result.assertions.passed ?? 0}/${
                            (result.assertions.passed ?? 0) + (result.assertions.failed ?? 0)
                          }`
                        : '',
                    ],
                    ['trace', 'Trace', ''],
                    ['history', 'History', history.length > 0 ? String(history.length) : ''],
                    ['seo', 'SEO', ''],
                    ['extract', 'Extract', ''],
                  ] as const
                ).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className="tab"
                    aria-selected={responseTab === id}
                    onClick={() => setResponseTab(id)}
                  >
                    {label}
                    {count ? <span className="count">{count}</span> : null}
                  </button>
                ))}
              </div>

              {responseTab === 'body' && result.ok ? (
                <>
                  {graphQLResult?.isGraphQL && graphQLResult.errors.length > 0 ? (
                    <div className="notice bad" role="alert">
                      <strong>
                        {graphQLResult.errors.length} GraphQL error
                        {graphQLResult.errors.length === 1 ? '' : 's'} in a 200
                        response
                      </strong>
                      <ul className="graphqlErrors">
                        {graphQLResult.errors.map((entry) => (
                          <li key={`${entry.path}-${entry.message}`}>
                            {entry.path ? <code>{entry.path}</code> : null} {entry.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <BodyViewer body={result.body ?? ''} headers={result.headers ?? {}} />
                </>
              ) : null}

              {responseTab === 'history' ? (
                <HistoryPanel
                  entries={history}
                  requestId={spec.id}
                  onReplay={(entry) => {
                    patch({ method: entry.method, url: entry.url });
                    setNotice({
                      text: `Restored ${entry.method} ${entry.url} into the editor.`,
                      tone: 'good',
                    });
                  }}
                  onClear={() => {
                    void clearHistory();
                    setHistory([]);
                  }}
                />
              ) : null}

              {responseTab === 'headers' ? (
                <pre>
                  {Object.entries(result.headers ?? {})
                    .map(([name, value]) => `${name}: ${value}`)
                    .join('\n') || '(none)'}
                </pre>
              ) : null}


              {responseTab === 'tests' ? (
                !result.assertions ? (
                  <p className="notice">
                    No assertions on this request. Add them in the Tests tab and
                    they run automatically on every send.
                  </p>
                ) : !result.assertions.ok ? (
                  <p className="notice bad">{result.assertions.error}</p>
                ) : (
                  <>
                    <p
                      className={`notice ${
                        (result.assertions.failed ?? 0) > 0 ? 'bad' : 'good'
                      }`}
                    >
                      {result.assertions.passed} passed,{' '}
                      {result.assertions.failed} failed
                    </p>
                    <ul className="hops">
                      {(result.assertions.results ?? []).map((assertion) => (
                        <li
                          key={assertion.name}
                          style={{
                            color: assertion.passed
                              ? 'var(--ok)'
                              : 'var(--deny)',
                          }}
                        >
                          {assertion.passed ? '\u2713' : '\u2717'} {assertion.name}
                          {assertion.error ? (
                            <div style={{ color: 'var(--muted)', marginTop: '0.15rem' }}>
                              {assertion.error}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                )
              ) : null}

              {responseTab === 'trace' ? (
                <>
                  <h2>Connections made</h2>
                  <ul className="hops">
                    {(result.hops ?? []).map((hop, index) => (
                      <li key={`${hop.url}-${index}`}>
                        {hop.status || '—'} · {hop.address} · {hop.url}
                      </li>
                    ))}
                  </ul>
                  {result.logs && result.logs.length > 0 ? (
                    <>
                      <h2 style={{ marginTop: '0.8rem' }}>Script output</h2>
                      <pre>{result.logs.join('\n')}</pre>
                    </>
                  ) : null}
                </>
              ) : null}

              {responseTab === 'seo' ? (
                <SeoPanel
                  body={result.body ?? ''}
                  contentType={result.headers?.['content-type']}
                  finalUrl={result.hops?.at(-1)?.url ?? spec.url}
                  headers={result.headers ?? {}}
                />
              ) : null}

              {responseTab === 'extract' ? (
                <ExtractPanel
                  body={result.body ?? ''}
                  contentType={result.headers?.['content-type']}
                  finalUrl={result.hops?.at(-1)?.url ?? spec.url}
                  headers={result.headers ?? {}}
                />
              ) : null}
            </>
          ) : !sending && !notice ? (
            <div className="responseEmpty">
              <div className="relayDiagram" aria-hidden="true">
                <span className="relayNode relayNode--client">URL</span>
                <span className="relayPath" />
                {/* A shield, not a tick: this node is the guard, and the thing
                    worth saying about it is that it refuses targets — a check
                    mark says "fine, carry on", which is the opposite. Drawn
                    rather than typed so it scales with the node instead of
                    inheriting the 0.68rem label size. */}
                <span className="relayNode relayNode--guard">
                  <svg
                    className="relayShield"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2.6 4.8 5.4v6c0 4.2 2.9 8 7.2 9.4 4.3-1.4 7.2-5.2 7.2-9.4v-6L12 2.6Z" />
                    <path d="m9 12.1 2.2 2.2L15.3 10" />
                  </svg>
                </span>
                <span className="relayPath" />
                <span className="relayNode relayNode--api">API</span>
              </div>
              <div>
                <h3>Ready for a request</h3>
                <p>
                  The relay resolves the target, blocks private networks, pins
                  the approved address, and checks every redirect before it
                  connects.
                </p>
              </div>
              <div className="responseFacts" aria-label="Relay protections">
                <span>SSRF guarded</span>
                <span>15s budget</span>
                <span>2 MB cap</span>
              </div>
              <button
                type="button"
                className="primary"
                disabled={spec.url.trim() === ''}
                onClick={() => void send()}
              >
                Send {spec.name}
              </button>
              {history.length > 0 ? (
                <details className="emptyHistory">
                  <summary>
                    {history.length} earlier response
                    {history.length === 1 ? '' : 's'} recorded in this browser
                  </summary>
                  <HistoryPanel
                    entries={history}
                    requestId={spec.id}
                    onReplay={(entry) => patch({ method: entry.method, url: entry.url })}
                    onClear={() => {
                      void clearHistory();
                      setHistory([]);
                    }}
                  />
                </details>
              ) : null}
              <p className="emptyHint">
                Or choose “Blocked: cloud metadata” to see a malicious target
                refused before any socket is opened.
              </p>
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}

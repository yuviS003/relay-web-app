/*
 * How good is the connection right now?
 *
 * A request client is judged on how fast it feels, and almost none of that is
 * the client: a send is the browser reaching this app, the app reaching the
 * target, and the target thinking. When a send takes four seconds, the useful
 * question is *which leg* took them, and without an answer the tool gets the
 * blame for the network.
 *
 * So this measures the two legs separately, from sends that have actually
 * happened:
 *
 *   upstream  what the relay reports for the target round trip
 *   overhead  everything else — the browser's hop to the app, the guard, the
 *             quota check, the sandbox, parsing
 *
 * Nothing here sends anything. Probing a third party on a timer to draw a
 * speedometer would spend the user's relay quota to tell them what their own
 * requests already said.
 */

export type NetworkSample = {
  at: number;
  /** Measured in the browser, start of fetch to parsed response. */
  totalMs: number;
  /** What the relay reported for the target round trip. */
  upstreamMs: number;
  bytes: number;
  ok: boolean;
};

export type NetworkGrade = 'unknown' | 'good' | 'fair' | 'slow';

/** What the browser says about the link, when it says anything. */
export type LinkInfo = {
  effectiveType?: string | undefined;
  rttMs?: number | undefined;
  downlinkMbps?: number | undefined;
};

export type NetworkHealth = {
  grade: NetworkGrade;
  samples: number;
  medianUpstreamMs: number | null;
  medianOverheadMs: number | null;
  /** Of the measured responses, not of the link; null when nothing to divide. */
  throughputKbps: number | null;
  link: LinkInfo | null;
  /** Chip text: short enough for a toolbar. */
  label: string;
  /** One sentence explaining the grade, for the popover. */
  detail: string;
};

/*
 * A dozen sends is enough to see through one slow outlier without averaging
 * away a connection that just got worse.
 */
export const SAMPLE_WINDOW = 12;

/** Medians, because one 4-second outlier should not define the connection. */
const GOOD_BELOW_MS = 400;
const FAIR_BELOW_MS = 1_200;

export function recordSample(
  samples: readonly NetworkSample[],
  sample: NetworkSample,
): NetworkSample[] {
  return [...samples, sample].slice(-SAMPLE_WINDOW);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function readable(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Reads the Network Information API without assuming it exists. */
export function readLinkInfo(navigatorLike: unknown): LinkInfo | null {
  if (typeof navigatorLike !== 'object' || navigatorLike === null) return null;
  const connection = (navigatorLike as { connection?: unknown }).connection;
  if (typeof connection !== 'object' || connection === null) return null;

  const source = connection as {
    effectiveType?: unknown;
    rtt?: unknown;
    downlink?: unknown;
  };
  const info: LinkInfo = {
    ...(typeof source.effectiveType === 'string'
      ? { effectiveType: source.effectiveType }
      : {}),
    ...(typeof source.rtt === 'number' && Number.isFinite(source.rtt)
      ? { rttMs: source.rtt }
      : {}),
    ...(typeof source.downlink === 'number' && Number.isFinite(source.downlink)
      ? { downlinkMbps: source.downlink }
      : {}),
  };
  return Object.keys(info).length > 0 ? info : null;
}

export function summariseNetwork(
  samples: readonly NetworkSample[],
  link: LinkInfo | null = null,
): NetworkHealth {
  const usable = samples.filter((sample) => sample.ok && sample.upstreamMs > 0);
  const upstream = median(usable.map((sample) => sample.upstreamMs));
  const overhead = median(
    usable.map((sample) => Math.max(0, sample.totalMs - sample.upstreamMs)),
  );

  const transferred = usable.filter((sample) => sample.bytes > 0 && sample.upstreamMs > 0);
  const throughputKbps =
    transferred.length === 0
      ? null
      : Math.round(
          median(
            transferred.map(
              (sample) => (sample.bytes * 8) / sample.upstreamMs, // bits per ms = kbit/s
            ),
          ) ?? 0,
        );

  if (upstream === null) {
    /*
     * Nothing sent yet. The link hint is still worth showing: it is free, it
     * arrives before the first request, and on a phone it is often the whole
     * story.
     */
    const hint = link?.effectiveType
      ? `link reports ${link.effectiveType}${
          link.rttMs ? `, ${Math.round(link.rttMs)}ms round trip` : ''
        }`
      : 'no sends measured yet';
    return {
      grade: 'unknown',
      samples: 0,
      medianUpstreamMs: null,
      medianOverheadMs: null,
      throughputKbps: null,
      link,
      label: 'Network ·  —',
      detail: `Send a request and this reports how much of the time was the target and how much was Relay. For now, ${hint}.`,
    };
  }

  const grade: NetworkGrade =
    upstream < GOOD_BELOW_MS ? 'good' : upstream < FAIR_BELOW_MS ? 'fair' : 'slow';

  const overheadText = overhead === null ? 'unknown' : readable(overhead);
  const detail =
    grade === 'slow'
      ? `Targets are answering in about ${readable(
          upstream,
        )} over the last ${usable.length} send${
          usable.length === 1 ? '' : 's'
        }, with ${overheadText} of that spent inside Relay. A send that feels slow is the network or the API, not the client.`
      : `Targets are answering in about ${readable(upstream)}, with ${overheadText} spent inside Relay.`;

  return {
    grade,
    samples: usable.length,
    medianUpstreamMs: upstream,
    medianOverheadMs: overhead,
    throughputKbps,
    link,
    label: `Network · ${readable(upstream)}`,
    detail,
  };
}

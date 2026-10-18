import { describe, expect, it } from 'vitest';

import {
  readLinkInfo,
  recordSample,
  SAMPLE_WINDOW,
  summariseNetwork,
  type NetworkSample,
} from '../src/lib/net/health';

/*
 * The indicator exists to answer one question correctly — "was that slow
 * because of this app?" — so the arithmetic behind the verdict is worth
 * pinning down. Getting it wrong in the flattering direction would be worse
 * than not having it.
 */

const sample = (overrides: Partial<NetworkSample> = {}): NetworkSample => ({
  at: 1,
  totalMs: 320,
  upstreamMs: 290,
  bytes: 1_024,
  ok: true,
  ...overrides,
});

describe('recordSample', () => {
  it('keeps a bounded window of the most recent sends', () => {
    let samples: NetworkSample[] = [];
    for (let index = 0; index < SAMPLE_WINDOW + 5; index += 1) {
      samples = recordSample(samples, sample({ at: index }));
    }
    expect(samples).toHaveLength(SAMPLE_WINDOW);
    expect(samples[0]?.at).toBe(5);
    expect(samples.at(-1)?.at).toBe(SAMPLE_WINDOW + 4);
  });
});

describe('summariseNetwork', () => {
  it('reports nothing measured before the first send', () => {
    const health = summariseNetwork([]);
    expect(health.grade).toBe('unknown');
    expect(health.medianUpstreamMs).toBeNull();
    expect(health.detail).toContain('no sends measured yet');
  });

  it('still offers the browser link hint with no sends', () => {
    const health = summariseNetwork([], { effectiveType: '3g', rttMs: 300 });
    expect(health.grade).toBe('unknown');
    expect(health.detail).toContain('3g');
    expect(health.detail).toContain('300ms');
  });

  it('grades on the median target latency, not the total', () => {
    // Fast targets, and this app adding a few milliseconds: good.
    const good = summariseNetwork([
      sample({ upstreamMs: 120, totalMs: 150 }),
      sample({ upstreamMs: 200, totalMs: 240 }),
      sample({ upstreamMs: 180, totalMs: 215 }),
    ]);
    expect(good.grade).toBe('good');
    expect(good.medianUpstreamMs).toBe(180);
    expect(good.medianOverheadMs).toBe(35);

    const fair = summariseNetwork([sample({ upstreamMs: 800, totalMs: 850 })]);
    expect(fair.grade).toBe('fair');

    const slow = summariseNetwork([
      sample({ upstreamMs: 3_900, totalMs: 4_015 }),
      sample({ upstreamMs: 2_200, totalMs: 2_260 }),
      sample({ upstreamMs: 2_500, totalMs: 2_560 }),
    ]);
    expect(slow.grade).toBe('slow');
    // The sentence has to put the blame in the right place; this is the whole
    // point of the feature.
    expect(slow.detail).toContain('not the client');
    expect(slow.label).toBe('Network · 2.5s');
  });

  it('is not swung by a single outlier', () => {
    const health = summariseNetwork([
      sample({ upstreamMs: 150, totalMs: 190 }),
      sample({ upstreamMs: 160, totalMs: 200 }),
      sample({ upstreamMs: 9_000, totalMs: 9_100 }),
      sample({ upstreamMs: 170, totalMs: 210 }),
    ]);
    expect(health.grade).toBe('good');
    expect(health.medianUpstreamMs).toBe(165);
  });

  it('ignores refusals and failures, which measure nothing about the network', () => {
    // A blocked target never opened a socket, and a zero duration would drag
    // the median towards "good" for a request that never left.
    const health = summariseNetwork([
      sample({ ok: false, upstreamMs: 0, totalMs: 40 }),
      sample({ upstreamMs: 2_000, totalMs: 2_080 }),
    ]);
    expect(health.samples).toBe(1);
    expect(health.medianUpstreamMs).toBe(2_000);
  });

  it('derives a response rate from bytes and the time they took', () => {
    // 10 KB in 100 ms is 800 kbit/s.
    const health = summariseNetwork([
      sample({ bytes: 10_000, upstreamMs: 100, totalMs: 130 }),
    ]);
    expect(health.throughputKbps).toBe(800);
  });

  it('leaves the rate unknown when nothing carried a body', () => {
    expect(
      summariseNetwork([sample({ bytes: 0, upstreamMs: 200, totalMs: 230 })])
        .throughputKbps,
    ).toBeNull();
  });
});

describe('readLinkInfo', () => {
  it('reads what the Network Information API offers', () => {
    expect(
      readLinkInfo({ connection: { effectiveType: '4g', rtt: 50, downlink: 10 } }),
    ).toEqual({ effectiveType: '4g', rttMs: 50, downlinkMbps: 10 });
  });

  it('returns null where the API is absent or empty, rather than guessing', () => {
    // Safari and Firefox do not implement it, and a partial object must not
    // produce fields that read as measurements.
    expect(readLinkInfo({})).toBeNull();
    expect(readLinkInfo(null)).toBeNull();
    expect(readLinkInfo('nonsense')).toBeNull();
    expect(readLinkInfo({ connection: {} })).toBeNull();
    expect(readLinkInfo({ connection: { rtt: Number.NaN } })).toBeNull();
  });
});

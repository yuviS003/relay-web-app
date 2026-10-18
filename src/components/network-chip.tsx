'use client';

import type { NetworkHealth } from '@/lib/net/health';

const TONE: Record<NetworkHealth['grade'], string> = {
  good: 'good',
  fair: 'warn',
  slow: 'bad',
  unknown: '',
};

const WORD: Record<NetworkHealth['grade'], string> = {
  good: 'Good',
  fair: 'Fair',
  slow: 'Slow',
  unknown: 'Not measured',
};

/**
 * Connection quality, measured from the sends that already happened.
 *
 * Exists because of a specific confusion: a four-second response looks like a
 * slow client, and there was nothing on screen to say that 3.9 of those
 * seconds were the target. The chip grades the connection, and opening it
 * splits the time between the network and Relay itself.
 */
export function NetworkChip({ health }: { health: NetworkHealth }) {
  const { grade, link, medianUpstreamMs, medianOverheadMs, throughputKbps, samples } =
    health;

  return (
    <details className="netChip">
      {/* The accessible name has to contain the visible text, or voice
          control cannot address what it can read — axe calls this
          label-content-name-mismatch, and it caught exactly that here. The
          grade is appended rather than substituted. */}
      <summary
        title={health.detail}
        aria-label={`${health.label} — ${WORD[grade]} connection`}
      >
        <span className={`netDot netDot--${grade}`} aria-hidden="true" />
        <span className="netLabel">{health.label}</span>
      </summary>
      <div className="netPopover">
        <p className={`netVerdict ${TONE[grade]}`}>{WORD[grade]}</p>
        <p className="hint">{health.detail}</p>
        <dl className="netFacts">
          <div>
            <dt>To the target</dt>
            <dd>
              {medianUpstreamMs === null ? '—' : `${Math.round(medianUpstreamMs)} ms`}
            </dd>
          </div>
          <div>
            <dt>Inside Relay</dt>
            <dd>
              {medianOverheadMs === null ? '—' : `${Math.round(medianOverheadMs)} ms`}
            </dd>
          </div>
          <div>
            <dt>Response rate</dt>
            <dd>{throughputKbps === null ? '—' : `${throughputKbps} kbit/s`}</dd>
          </div>
          <div>
            <dt>Measured over</dt>
            <dd>
              {samples} send{samples === 1 ? '' : 's'}
            </dd>
          </div>
          {link ? (
            <div>
              <dt>Browser reports</dt>
              <dd>
                {[
                  link.effectiveType,
                  link.rttMs ? `${Math.round(link.rttMs)} ms rtt` : null,
                  link.downlinkMbps ? `${link.downlinkMbps} Mbit/s` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </dd>
            </div>
          ) : null}
        </dl>
        <p className="hint">
          Medians, so one slow outlier does not define the verdict. Nothing is
          probed in the background: these are your own requests.
        </p>
      </div>
    </details>
  );
}

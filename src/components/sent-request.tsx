'use client';

import { useState } from 'react';

import { isSensitiveHeader } from '@/lib/headers-catalog';

import { BodyViewer } from './body-viewer';

export type SentRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * The request as it actually left the proxy.
 *
 * Not the same thing as the editor above it: {{variables}} are resolved here,
 * the cookie jar's header has been added, and auth that is applied on the
 * server — a bearer token, an AWS signature, an OAuth2 access token the relay
 * fetched — exists only in this view. When a server rejects a request, this is
 * the only honest answer to "what did you send?".
 *
 * Credential values start hidden. The point is to read a request, often with
 * someone watching or a screenshot being taken, and a bearer token does not
 * need to be on screen for that.
 */
export function SentRequestPanel({ sent }: { sent: SentRequest }) {
  const [revealed, setRevealed] = useState(false);

  const headers = Object.entries(sent.headers).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const sensitive = headers.filter(([name]) => isSensitiveHeader(name)).length;

  return (
    <div className="sentRequest">
      <p className="hint">
        What the relay sent after substitution, including the headers it added
        for you. The editor shows what you wrote; this shows what went out.
      </p>

      <div className="sentLine">
        <span className={`verb verb-${sent.method.toUpperCase()}`}>
          {sent.method.toUpperCase()}
        </span>
        <code className="sentUrl">{sent.url}</code>
      </div>

      <div className="sentHeadingRow">
        <h2>
          {headers.length} header{headers.length === 1 ? '' : 's'}
        </h2>
        {sensitive > 0 ? (
          <button
            type="button"
            className="ghost"
            aria-pressed={revealed}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? 'Hide credentials' : `Show ${sensitive} credential value${sensitive === 1 ? '' : 's'}`}
          </button>
        ) : null}
      </div>

      {headers.length === 0 ? (
        <p className="captureEmpty">No headers were sent.</p>
      ) : (
        <ul className="kvList sentHeaders">
          {headers.map(([name, value]) => {
            const hidden = isSensitiveHeader(name) && !revealed;
            return (
              <li key={name}>
                <code>{name}</code>
                <span className={hidden ? 'sentHidden' : 'sentValue'}>
                  {hidden ? `${'•'.repeat(12)} ${value.length} characters` : value}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <h2 style={{ marginTop: '0.8rem' }}>Body</h2>
      {sent.body === '' ? (
        <p className="captureEmpty">No body was sent.</p>
      ) : (
        // The same viewer as the response, so a sent JSON payload gets the
        // tree and the path filter rather than one long line.
        <BodyViewer body={sent.body} headers={sent.headers} />
      )}
    </div>
  );
}

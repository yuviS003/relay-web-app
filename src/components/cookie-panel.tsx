'use client';

import { cookieHeaderFor, type CookieJar } from '@/lib/cookies';

type CookiePanelProps = {
  jar: CookieJar;
  /** The URL being edited, to show what would actually be sent. */
  url: string;
  onRemove: (name: string, domain: string, path: string) => void;
  onClear: () => void;
};

function expiry(at: number | null): string {
  if (at === null) return 'session';
  const remaining = at - Date.now();
  if (remaining <= 0) return 'expired';
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * The cookie jar, and what it would send to the current URL.
 *
 * Shown rather than hidden because a jar is a pile of credentials: knowing
 * which cookie goes where is the difference between a working session and one
 * leaked to an unrelated host. Scope rules are enforced in lib/cookies.ts —
 * this view just makes them visible.
 */
export function CookiePanel({ jar, url, onRemove, onClear }: CookiePanelProps) {
  const applies = url.trim() === '' ? '' : cookieHeaderFor(jar, url);

  return (
    <div className="cookiePanel">
      <p className="hint">
        Cookies from <code>Set-Cookie</code> are kept for this tab only, never
        written to storage and never sent to a host their domain, path or
        Secure flag does not cover.
      </p>

      <div className="dialogField">
        <label htmlFor="cookie-outgoing">Would be sent to this URL</label>
        <output id="cookie-outgoing" className="cookieOutgoing">
          {applies === '' ? 'nothing' : applies}
        </output>
      </div>

      {jar.length === 0 ? (
        <p className="captureEmpty">The jar is empty.</p>
      ) : (
        <>
          <ul className="cookieList">
            {jar.map((cookie) => (
              <li key={`${cookie.domain}${cookie.path}${cookie.name}`}>
                <code className="truncate">{cookie.name}</code>
                <span className="truncate">{cookie.value}</span>
                <span className="cookieScope">
                  {cookie.hostOnly ? cookie.domain : `*.${cookie.domain}`}
                  {cookie.path}
                </span>
                <span className="cookieFlags">
                  {[
                    cookie.secure ? 'Secure' : null,
                    cookie.httpOnly ? 'HttpOnly' : null,
                    cookie.sameSite ? `SameSite=${cookie.sameSite}` : null,
                    expiry(cookie.expiresAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <button
                  type="button"
                  className="iconBtn"
                  aria-label={`Remove ${cookie.name}`}
                  onClick={() => onRemove(cookie.name, cookie.domain, cookie.path)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onClear}>
            Empty the jar
          </button>
        </>
      )}
    </div>
  );
}

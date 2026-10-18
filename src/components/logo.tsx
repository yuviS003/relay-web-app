/**
 * Wordmark glyph: a request leaving a client, passing a shield, and arriving.
 * `currentColor` on the stroke means it inherits the theme without a second
 * asset for light and dark.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Web API client"
      fill="none"
    >
      <rect
        x="1.25"
        y="6.75"
        width="6"
        height="10.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M7.25 12h3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M15.5 4.75l4.25 1.9v4.6c0 3.5-2.1 5.9-4.25 6.9-2.15-1-4.25-3.4-4.25-6.9v-4.6z"
        fill="var(--accent)"
        stroke="var(--accent)"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M13.6 11.3l1.5 1.5 2.9-3"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19.9 19.5h2.85"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

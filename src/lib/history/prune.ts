/*
 * What history is allowed to keep.
 *
 * History lives in the browser, where storage is shared with every other site
 * and a quota error arrives as a failed write rather than a warning. So the
 * policy is explicit and tested: newest first, bounded by a count and by total
 * recorded bytes, with each stored body capped on the way in.
 *
 * Kept apart from the IndexedDB code so the rules can be tested without a
 * browser, and so a storage change cannot quietly change the retention.
 */

export type HistoryEntry = {
  id: string;
  /** Epoch milliseconds. */
  at: number;
  requestId: string;
  name: string;
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  blocked: boolean;
  durationMs: number;
  bodyBytes: number;
  /** Truncated copy of the response body, for diffing and re-reading. */
  body: string;
  bodyTruncated: boolean;
  headers: Record<string, string>;
  assertions: { passed: number; failed: number } | null;
};

export const HISTORY_MAX_ENTRIES = 100;
export const HISTORY_MAX_BODY_BYTES = 64 * 1024;
export const HISTORY_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/** Cuts a body to the per-entry cap, counting UTF-16 code units as bytes. */
export function capBody(
  body: string,
  limit = HISTORY_MAX_BODY_BYTES,
): { body: string; truncated: boolean } {
  if (body.length <= limit) return { body, truncated: false };
  return { body: body.slice(0, limit), truncated: true };
}

export function entrySize(entry: HistoryEntry): number {
  // Close enough to the stored size to budget with, and cheap: the body
  // dominates, and JSON.stringify of a 64 KB body on every write is not free.
  return (
    entry.body.length +
    entry.url.length +
    entry.name.length +
    Object.entries(entry.headers).reduce(
      (sum, [name, value]) => sum + name.length + value.length,
      0,
    ) +
    128
  );
}

/**
 * The entries to keep, newest first, within both budgets.
 *
 * Returns a new array rather than mutating: the caller writes the result back,
 * so a failed write leaves the previous history intact.
 */
export function pruneHistory(
  entries: readonly HistoryEntry[],
  limits: { maxEntries?: number; maxTotalBytes?: number } = {},
): HistoryEntry[] {
  const maxEntries = limits.maxEntries ?? HISTORY_MAX_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? HISTORY_MAX_TOTAL_BYTES;

  const newestFirst = [...entries].sort((a, b) => b.at - a.at);
  const kept: HistoryEntry[] = [];
  let total = 0;

  for (const entry of newestFirst) {
    if (kept.length >= maxEntries) break;
    const size = entrySize(entry);
    // The newest entry is always kept, even if it alone exceeds the budget:
    // dropping what just happened would make history useless at the moment it
    // matters most.
    if (kept.length > 0 && total + size > maxTotalBytes) continue;
    kept.push(entry);
    total += size;
  }

  return kept;
}



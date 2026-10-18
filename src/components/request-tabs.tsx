'use client';

import type { RequestSpec } from '@/lib/store/types';

export function RequestTabs({
  requests,
  activeId,
  onSelect,
  onClose,
  onCreate,
}: {
  requests: readonly RequestSpec[];
  activeId: string;
  onSelect: (request: RequestSpec) => void;
  onClose: (id: string) => void;
  onCreate: () => void;
}) {
  /*
   * A list, not a tablist.
   *
   * Each entry carries its own close button, and a tablist may only own tabs —
   * so the previous markup was a critical accessibility violation however the
   * wrapper was labelled. A list of open requests, with the current one marked
   * by aria-current, says the same thing and is structurally valid.
   */
  return (
    <div className="requestTabs">
      <ul className="requestTabsScroller" aria-label="Open requests">
        {requests.map((request) => (
          <li
            key={request.id}
            className="requestTab"
            data-active={request.id === activeId}
          >
            <button
              type="button"
              aria-current={request.id === activeId}
              className="requestTabMain"
              onClick={() => onSelect(request)}
            >
              <span className={`verb verb-${request.method}`}>
                {request.method}
              </span>
              <span className="truncate">{request.name}</span>
            </button>
            <button
              type="button"
              className="requestTabClose"
              aria-label={`Close ${request.name}`}
              onClick={() => onClose(request.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="requestTabAdd"
        aria-label="Create request"
        title="Create request"
        onClick={onCreate}
      >
        +
      </button>
    </div>
  );
}

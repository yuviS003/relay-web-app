'use client';

import { useState, type DragEvent } from 'react';

import type { Collection, RequestSpec } from '@/lib/store/types';

/** Where a dragged request should land: before `beforeId`, or last when null. */
export type RequestMove = {
  requestId: string;
  from: string;
  to: string;
  beforeId: string | null;
};

/**
 * Where the drop would land, and which feedback to draw for it. `via` keeps
 * the two apart: a position between rows is an insertion line, a whole
 * collection is an outline. Without it, dropping below the last row showed
 * both at once.
 */
type DropMark = {
  collectionId: string;
  beforeId: string | null;
  via: 'row' | 'collection';
};

type RequestListProps = {
  collections: readonly Collection[];
  activeId: string;
  onOpen: (request: RequestSpec) => void;
  onRename: (request: RequestSpec) => void;
  onDelete: (request: RequestSpec) => void;
  onMove: (move: RequestMove) => void;
  onRun: (collection: Collection) => void;
};

const MIME = 'application/x-relay-request';

function closeMenu(element: HTMLElement) {
  element.closest('details')?.removeAttribute('open');
}

/**
 * Collections and their requests, reorderable by drag and drop.
 *
 * Dropping follows the file-manager convention: the pointer's half of a row
 * decides whether the request lands above or below it, and dropping on a
 * collection appends to that collection. Every move is also available from the
 * row menu, because drag and drop is unusable with a keyboard and the menu is
 * the only path a screen reader can follow.
 */
export function RequestList({
  collections,
  activeId,
  onOpen,
  onRename,
  onDelete,
  onMove,
  onRun,
}: RequestListProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [mark, setMark] = useState<DropMark | null>(null);

  const ownerOf = (requestId: string) =>
    collections.find((collection) =>
      collection.requests.some((request) => request.id === requestId),
    );

  const clear = () => {
    setDraggingId(null);
    setMark(null);
  };

  const startDrag = (event: DragEvent<HTMLLIElement>, request: RequestSpec) => {
    // Dragging from inside the overflow menu would be a misclick, not a move.
    if ((event.target as HTMLElement).closest('.reqMenu')) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(MIME, request.id);
    event.dataTransfer.setData('text/plain', request.name);
    setDraggingId(request.id);
  };

  const dragOverRow = (
    event: DragEvent<HTMLLIElement>,
    collection: Collection,
    request: RequestSpec,
    index: number,
  ) => {
    if (!draggingId) return;
    // Stops the collection-level handler below from overriding this precise
    // position with a plain "append to the end".
    event.stopPropagation();
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    const below = event.clientY > box.top + box.height / 2;
    const beforeId = below
      ? (collection.requests[index + 1]?.id ?? null)
      : request.id;
    setMark({ collectionId: collection.id, beforeId, via: 'row' });
  };

  const dragOverCollection = (
    event: DragEvent<HTMLElement>,
    collection: Collection,
  ) => {
    if (!draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setMark({ collectionId: collection.id, beforeId: null, via: 'collection' });
  };

  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const from = draggingId ? ownerOf(draggingId)?.id : undefined;
    if (draggingId && mark && from) {
      onMove({ requestId: draggingId, from, to: mark.collectionId, beforeId: mark.beforeId });
    }
    clear();
  };

  /** Row menu equivalent of a drag: shift one position inside the collection. */
  const nudge = (collection: Collection, request: RequestSpec, index: number, delta: number) => {
    const swapWith = collection.requests[index + delta];
    if (!swapWith) return;
    // Moving down means landing before the request after the one swapped with.
    const beforeId =
      delta < 0
        ? swapWith.id
        : (collection.requests[index + delta + 1]?.id ?? null);
    onMove({
      requestId: request.id,
      from: collection.id,
      to: collection.id,
      beforeId,
    });
  };

  return (
    <>
      {collections.map((collection) => {
        const intoThis = mark?.collectionId === collection.id;
        return (
          <section
            className={`collectionGroup${
              intoThis && mark?.via === 'collection' ? ' collectionGroup--dropInto' : ''
            }`}
            key={collection.id}
            onDragOver={(event) => dragOverCollection(event, collection)}
            onDrop={drop}
          >
            <div className="collectionHeading">
              <span className="collectionCaret" aria-hidden="true">
                ▾
              </span>
              <strong className="truncate">{collection.name}</strong>
              <span>{collection.requests.length}</span>
              <button
                type="button"
                className="collectionRun"
                data-tour="collection-run"
                aria-label={`Run ${collection.name}`}
                title="Run every request in order"
                disabled={collection.requests.length === 0}
                onClick={() => onRun(collection)}
              >
                ▶
              </button>
            </div>
            <ul className="reqList" aria-label={`${collection.name} requests`}>
              {collection.requests.length === 0 ? (
                <li className="reqEmpty">Drop a request here</li>
              ) : null}
              {collection.requests.map((request, index) => {
                const last = index === collection.requests.length - 1;
                const onRow = intoThis && mark?.via === 'row';
                const dropBefore = onRow && mark?.beforeId === request.id;
                const dropAfter = onRow && mark?.beforeId === null && last;
                return (
                  <li
                    className={`reqItem${
                      draggingId === request.id ? ' reqItem--dragging' : ''
                    }${dropBefore ? ' reqItem--dropBefore' : ''}${
                      dropAfter ? ' reqItem--dropAfter' : ''
                    }`}
                    key={request.id}
                    draggable
                    onDragStart={(event) => startDrag(event, request)}
                    onDragOver={(event) =>
                      dragOverRow(event, collection, request, index)
                    }
                    onDrop={drop}
                    onDragEnd={clear}
                  >
                    <button
                      type="button"
                      className="reqOpen"
                      aria-current={request.id === activeId}
                      // The sidebar is narrow, so long names ellipsise; the
                      // tooltip is how you read the rest of one.
                      title={`${request.method} ${request.name}`}
                      onClick={() => onOpen(request)}
                      onDoubleClick={() => onRename(request)}
                    >
                      <span className={`verb verb-${request.method}`}>
                        {request.method}
                      </span>
                      <span className="truncate">{request.name}</span>
                    </button>
                    <details className="reqMenu">
                      <summary
                        aria-label={`Actions for ${request.name}`}
                        title="Request actions"
                      >
                        <span aria-hidden="true">•••</span>
                      </summary>
                      <div className="reqMenuPopover">
                        <button
                          type="button"
                          onClick={(event) => {
                            closeMenu(event.currentTarget);
                            onRename(request);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={(event) => {
                            closeMenu(event.currentTarget);
                            nudge(collection, request, index, -1);
                          }}
                        >
                          Move up
                        </button>
                        <button
                          type="button"
                          disabled={last}
                          onClick={(event) => {
                            closeMenu(event.currentTarget);
                            nudge(collection, request, index, 1);
                          }}
                        >
                          Move down
                        </button>
                        {collections.length > 1 ? (
                          <>
                            <hr />
                            <p className="reqMenuGroup">Move to</p>
                            {collections
                              .filter((candidate) => candidate.id !== collection.id)
                              .map((candidate) => (
                                <button
                                  type="button"
                                  key={candidate.id}
                                  onClick={(event) => {
                                    closeMenu(event.currentTarget);
                                    onMove({
                                      requestId: request.id,
                                      from: collection.id,
                                      to: candidate.id,
                                      beforeId: null,
                                    });
                                  }}
                                >
                                  <span className="truncate">{candidate.name}</span>
                                </button>
                              ))}
                          </>
                        ) : null}
                        <hr />
                        <button
                          type="button"
                          className="dangerAction"
                          onClick={(event) => {
                            closeMenu(event.currentTarget);
                            onDelete(request);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}

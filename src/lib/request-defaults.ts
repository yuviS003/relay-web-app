import type { BodyMode, HeaderPair } from '@/lib/store/types';

/*
 * Defaults for a newly created request.
 *
 * A blank header table is a small, repeated tax: nearly every API call wants
 * `Accept`, and a request with a body is useless without `Content-Type` — a
 * missing one is the usual cause of an unexplained 415. Seeding them means the
 * common case needs no typing, and they are ordinary editable rows, so nothing
 * here is forced on a request that does not want it.
 *
 * Kept deliberately small. Only headers that are correct for essentially every
 * request are included; anything that depends on the endpoint (authorization,
 * idempotency keys, correlation ids) is left to the header suggestions, since a
 * wrong default is worse than an absent one. Nothing references a `{{variable}}`
 * either, because an unset placeholder would be sent literally.
 */

/** Methods that normally carry a request body. */
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

export function methodSendsBody(method: string): boolean {
  return METHODS_WITH_BODY.has(method.trim().toUpperCase());
}

/**
 * Header rows for a new request of this method.
 *
 * `Content-Type` leads for a body-carrying method so it sits next to the body
 * editor's own format control, which writes the same header.
 */
export function defaultHeaders(method: string): HeaderPair[] {
  const headers: HeaderPair[] = [];

  if (methodSendsBody(method)) {
    headers.push({ name: 'content-type', value: 'application/json', enabled: true });
  }

  headers.push({ name: 'accept', value: 'application/json', enabled: true });
  // An API client exists to show what the server returns right now; a cached
  // 200 from an intermediary is actively misleading while debugging.
  headers.push({ name: 'cache-control', value: 'no-cache', enabled: true });

  return headers;
}

/** Body editor mode matching the seeded Content-Type. */
export function defaultBodyMode(method: string): BodyMode {
  return methodSendsBody(method) ? 'json' : 'none';
}

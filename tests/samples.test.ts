import { describe, expect, it } from 'vitest';

import { parseJsonPath } from '../src/lib/json-path';
import { findPlaceholderNames, findScriptAssignments } from '../src/lib/placeholders';
import { SAMPLE_COLLECTIONS, STARTER_COLLECTION } from '../src/lib/store/samples';
import { compareCollections, parseCollection } from '../src/lib/store/types';
import type { Collection, RequestSpec } from '../src/lib/store/types';

/*
 * The seed is data, and data that ships to every new account is exactly the
 * kind that rots quietly: a typo in a capture path or a placeholder nobody
 * defines produces a workspace whose samples fail, which is worse than an
 * empty one. These assertions are the proof that the shipped seed is coherent
 * — they cannot prove the demo services are up, which is what the e2e run and
 * the assertions inside the samples themselves are for.
 */

const ALL_REQUESTS: readonly { collection: Collection; request: RequestSpec }[] =
  SAMPLE_COLLECTIONS.flatMap((collection) =>
    collection.requests.map((request) => ({ collection, request })),
  );

/** Every placeholder a request's substituted parts mention. */
function placeholdersOf(request: RequestSpec): string[] {
  const texts = [
    request.url,
    request.body,
    ...request.headers.map((pair) => pair.value),
    ...Object.values(request.auth ?? {}),
  ];
  const names = new Set<string>();
  for (const text of texts) {
    for (const name of findPlaceholderNames(String(text))) names.add(name);
  }
  return [...names];
}

describe('the sample workspace', () => {
  it('survives the validator every store read puts it through', () => {
    for (const collection of SAMPLE_COLLECTIONS) {
      expect(() => parseCollection(collection), collection.id).not.toThrow();
    }
  });

  it('leads with the starter collection the empty state names', () => {
    expect(SAMPLE_COLLECTIONS[0]).toBe(STARTER_COLLECTION);
    expect(STARTER_COLLECTION.requests.map((request) => request.name)).toContain(
      'Blocked: cloud metadata',
    );
  });

  it('keeps every collection id and request id unique', () => {
    const collectionIds = SAMPLE_COLLECTIONS.map((collection) => collection.id);
    expect(new Set(collectionIds).size).toBe(collectionIds.length);

    // Unique across the whole workspace, not just inside one collection: the
    // command palette, the open tabs and a cross-collection move all key on
    // the request id alone.
    const requestIds = ALL_REQUESTS.map(({ request }) => request.id);
    expect(new Set(requestIds).size).toBe(requestIds.length);
  });

  it('gives every request a name no other request starts with', () => {
    // Sidebar lookups and the browser suite match on "METHOD Name", so one
    // name being a prefix of another makes those matches ambiguous.
    const labels = ALL_REQUESTS.map(
      ({ request }) => `${request.method} ${request.name}`,
    );
    for (const label of labels) {
      const prefixed = labels.filter((other) => other.startsWith(label));
      expect(prefixed, label).toEqual([label]);
    }
  });

  it('resolves every placeholder from a variable, a capture or a script', () => {
    for (const { collection, request } of ALL_REQUESTS) {
      const available = new Set<string>([
        ...(collection.variables ?? []).map((variable) => variable.name),
        ...findScriptAssignments(request.preRequestScript),
        // A capture from any step in the same collection: the runner carries
        // the variable map forward, so order inside the collection decides
        // whether it is set at send time, not whether it exists.
        ...collection.requests.flatMap((other) =>
          (other.captures ?? []).map((capture) => capture.name),
        ),
      ]);

      for (const name of placeholdersOf(request)) {
        expect(available.has(name), `${request.id} uses {{${name}}}`).toBe(true);
      }
    }
  });

  it('writes every capture with a path the reader can parse', () => {
    for (const { request } of ALL_REQUESTS) {
      for (const capture of request.captures ?? []) {
        if (capture.from !== 'body') continue;
        expect(
          () => parseJsonPath(capture.path),
          `${request.id} captures ${capture.name}`,
        ).not.toThrow();
      }
    }
  });

  it('never writes a credential as a literal', () => {
    // Credentials belong in variables, which is the habit the seed is meant to
    // teach: what a collection stores is a reference.
    const secretish = [
      'password',
      'token',
      'secretAccessKey',
      'accessKeyId',
      'clientSecret',
      'refreshToken',
    ] as const;

    for (const { request } of ALL_REQUESTS) {
      for (const field of secretish) {
        const value = request.auth?.[field];
        if (value === undefined) continue;
        expect(value, `${request.id}.auth.${field}`).toMatch(/^\{\{[a-z_]+\}\}$/);
      }
    }
  });

  it('only leaves https for the request that exists to be refused', () => {
    const plain = ALL_REQUESTS.filter(({ request }) =>
      request.url.startsWith('http://'),
    );
    expect(plain.map(({ request }) => request.id)).toEqual(['blocked-metadata']);
  });

  it('pins a sidebar position so the store cannot reorder the tour', () => {
    // Sorting by name alone scattered the reading order: "Auth helpers" came
    // before "Starter", which the tour and the empty state both point at.
    expect(SAMPLE_COLLECTIONS.map((collection) => collection.order)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect([...SAMPLE_COLLECTIONS].sort(compareCollections)).toEqual([
      ...SAMPLE_COLLECTIONS,
    ]);
    // A collection someone made has no position and leads, by name.
    const mine: Collection = { id: 'mine', name: 'Zebra', requests: [] };
    expect(
      [...SAMPLE_COLLECTIONS, mine].sort(compareCollections)[0]?.id,
    ).toBe('mine');
  });

  it('covers each feature family once, in sidebar order', () => {
    // A rename is fine; a disappearance is not. The tour, the README and the
    // browser suite all describe this list.
    expect(SAMPLE_COLLECTIONS.map((collection) => collection.id)).toEqual([
      'starter',
      'samples-chain',
      'samples-auth',
      'samples-cookies',
      'samples-viewers',
      'samples-graphql',
    ]);

    const kinds = new Set(
      ALL_REQUESTS.map(({ request }) => request.auth?.kind).filter(Boolean),
    );
    expect([...kinds].sort()).toEqual(['basic', 'bearer', 'oauth2', 'sigv4']);

    const chained = SAMPLE_COLLECTIONS.find(
      (collection) => collection.id === 'samples-chain',
    );
    expect(
      chained?.requests.flatMap((request) => request.captures ?? []).length,
    ).toBeGreaterThan(0);
  });

  it('asserts something about every sample it sends', () => {
    for (const { request } of ALL_REQUESTS) {
      // Except the refusal demo, which never reaches a response to assert on.
      if (request.id === 'blocked-metadata') continue;
      expect(request.testScript, request.id).toContain('test(');
    }
  });
});

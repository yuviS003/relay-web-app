import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getStore,
  getStoreKind,
  SAMPLE_COLLECTIONS,
  type Store,
} from '../src/lib/store';
import type { Collection, Environment } from '../src/lib/store/types';

/*
 * Exercises the MongoDB path against a real cluster. Skipped when MONGODB_URI
 * is absent, so a fresh clone with no accounts still has a green suite.
 *
 * Uses MONGODB_TEST_DB, never the app's database, so running tests can never
 * disturb saved work. Documents are removed afterwards.
 */
const uri = process.env.MONGODB_URI;
const testDb = process.env.MONGODB_TEST_DB ?? 'web_api_client_test';

/*
 * Probe the cluster once, before the suite is collected, and skip rather than
 * fail when it cannot be reached.
 *
 * An unreachable database is an environment condition, not a defect in this
 * code: a developer without credentials, a CI job with no egress, or an IP
 * missing from the Atlas access list should all see a green suite with a clear
 * note, not a red one that hides whether the actual logic works.
 *
 * Atlas signals a blocked IP by accepting the TCP connection and then failing
 * the TLS handshake, which reads as a certificate problem. The reason is
 * printed so nobody loses an afternoon to that.
 */
async function clusterReachable(): Promise<boolean> {
  if (!uri) return false;

  const probe = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
  });
  try {
    await probe.connect();
    await probe.db().admin().ping();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = /tlsv1 alert internal error|ssl3_read_bytes/i.test(message);
    console.warn(
      `\n  [store.mongo] skipped: cluster unreachable.\n  ${
        blocked
          ? 'TLS was rejected after the TCP connection succeeded, which is how Atlas reports an IP that is not in the Network Access list.'
          : message.split('\n')[0]
      }\n`,
    );
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

const reachable = await clusterReachable();
const live = describe.skipIf(!reachable);

let store: Store;
let client: MongoClient | null = null;

const collection: Collection = {
  id: 'suite-collection',
  name: 'Suite collection',
  requests: [
    {
      id: 'suite-request',
      name: 'Suite request',
      method: 'POST',
      url: 'https://api.example.com/things?q={{term}}',
      headers: [{ name: 'content-type', value: 'application/json', enabled: true }],
      body: '{"ok":true}',
      preRequestScript: 'vars.term = "x";',
      testScript: "test('ok', () => expect(response.status).toBe(200));",
    },
  ],
};

const environment: Environment = {
  id: 'suite-env',
  name: 'Suite env',
  salt: 'c2FsdHNhbHRzYWx0c2E=',
  variables: [
    { name: 'base', value: 'https://api.example.com', secret: false },
    { name: 'token', value: 'aXZpdg==.Y2lwaGVy', secret: true },
  ],
};

beforeAll(async () => {
  if (!reachable || !uri) return;
  // Point the store at the test database before resolving it.
  process.env.MONGODB_DB = testDb;
  store = getStore('suite-owner', true);
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
});

afterAll(async () => {
  if (!client) return;
  const db = client.db(testDb);
  await db.collection('collections').deleteMany({});
  await db.collection('environments').deleteMany({});
  await db.collection('workspace_meta').deleteMany({ ownerId: 'suite-owner' });
  await client.close();
});

live('MongoDB store', () => {
  it('seeds the sample collections once for a new owner', async () => {
    const db = client!.db(testDb);
    await db.collection('collections').deleteMany({ ownerId: 'suite-owner' });
    await db.collection('workspace_meta').deleteMany({ ownerId: 'suite-owner' });

    await store.ensureSamples();
    await store.ensureSamples();

    const listed = await store.listCollections();
    expect(listed).toHaveLength(SAMPLE_COLLECTIONS.length);
    // Read back through the validator, so a seed the store would reject on
    // the way out fails here rather than in someone's workspace.
    const starter = listed.find((candidate) => candidate.id === 'starter');
    expect(starter?.requests.length).toBeGreaterThanOrEqual(4);
    expect(
      listed.some((candidate) => (candidate.variables ?? []).length > 0),
    ).toBe(true);

    // The second call is a no-op, not a second copy of every collection.
    const raw = await db
      .collection('collections')
      .countDocuments({ ownerId: 'suite-owner' });
    expect(raw).toBe(SAMPLE_COLLECTIONS.length);
  });

  it('reports mongodb as the active store', () => {
    expect(getStoreKind(true)).toBe('mongodb');
  });

  it('round-trips a collection through the cluster', async () => {
    const saved = await store.saveCollection(collection);
    expect(saved.id).toBe('suite-collection');

    const listed = await store.listCollections();
    const found = listed.find((candidate) => candidate.id === 'suite-collection');
    expect(found).toBeDefined();
    // Nested request detail must survive the trip, not just the envelope.
    expect(found?.requests[0]?.preRequestScript).toBe('vars.term = "x";');
    expect(found?.requests[0]?.headers[0]?.name).toBe('content-type');
  });

  it('upserts rather than duplicating on a second save', async () => {
    await store.saveCollection({ ...collection, name: 'Renamed' });
    const listed = await store.listCollections();
    const matches = listed.filter((c) => c.id === 'suite-collection');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe('Renamed');
  });

  it('round-trips an environment, keeping ciphertext byte-identical', async () => {
    await store.saveEnvironment(environment);
    const listed = await store.listEnvironments();
    const found = listed.find((candidate) => candidate.id === 'suite-env');

    // If the driver or validator mangled this, secrets would silently fail to
    // decrypt and look like a wrong passphrase.
    expect(found?.variables.find((v) => v.name === 'token')?.value).toBe(
      'aXZpdg==.Y2lwaGVy',
    );
    expect(found?.salt).toBe(environment.salt);
  });

  it('rejects an invalid document instead of writing it', async () => {
    await expect(
      store.saveCollection({ ...collection, id: 'has spaces' }),
    ).rejects.toThrow(/collection.id/);
  });

  it('revalidates on read, so a bad document cannot reach the app', async () => {
    /*
     * Writes a malformed document straight past the validator, simulating a
     * row left by an older version of the app, then asserts the read path
     * refuses it. Without this, a bad document would flow into the UI and
     * produce a malformed outbound request.
     */
    const db = client!.db(testDb);
    await db.collection('collections').insertOne({
      ownerId: 'suite-owner',
      id: 'corrupt',
      name: 'Corrupt',
      requests: [{ id: 'x', name: 'x', method: 'TELEPORT', url: '', headers: [], body: '', preRequestScript: '' }],
    });

    await expect(store.listCollections()).rejects.toThrow(/method/);

    await db.collection('collections').deleteOne({ id: 'corrupt' });
  });

  it('deletes and reports whether anything was removed', async () => {
    expect(await store.deleteCollection('suite-collection')).toBe(true);
    expect(await store.deleteCollection('suite-collection')).toBe(false);

    expect(await store.deleteEnvironment('suite-env')).toBe(true);
    expect(await store.deleteEnvironment('suite-env')).toBe(false);
  });
});

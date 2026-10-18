import { getDb } from './db';
import { SAMPLE_COLLECTIONS, STARTER_COLLECTION } from './samples';
import {
  compareCollections,
  parseCollection,
  parseEnvironment,
  type Collection,
  type Environment,
} from './types';

export { SAMPLE_COLLECTIONS, STARTER_COLLECTION };

/*
 * Saved collections and environments, scoped to an owner.
 *
 * Mongo has no row-level security, so isolation cannot be delegated to the
 * database. It is enforced here instead: a store is constructed *for* an owner
 * and every query carries that owner in its filter. There is deliberately no
 * way to ask this module for "all collections" — the owner is a constructor
 * argument rather than a method parameter, so a caller cannot forget to pass
 * it and silently read someone else's work.
 */
export type Store = {
  /** Writes the sample collections once, for a new owner only. */
  ensureSamples(): Promise<void>;
  listCollections(): Promise<readonly Collection[]>;
  saveCollection(input: unknown): Promise<Collection>;
  deleteCollection(id: string): Promise<boolean>;
  listEnvironments(): Promise<readonly Environment[]>;
  saveEnvironment(input: unknown): Promise<Environment>;
  deleteEnvironment(id: string): Promise<boolean>;
};

export type StoreKind = 'mongodb' | 'memory';

const MEMORY_KEY = '__wac_memory_stores__';

type OwnedDoc = { ownerId: string };
type GlobalCache = typeof globalThis & {
  [MEMORY_KEY]?: Map<string, Store>;
};

function createMemoryStore(): Store {
  const collections = new Map<string, Collection>(
    SAMPLE_COLLECTIONS.map((collection) => [collection.id, collection]),
  );
  const environments = new Map<string, Environment>();

  return {
    async ensureSamples() {
      // Already present from construction; the method keeps callers agnostic
      // to whether this is memory or Mongo.
    },
    async listCollections() {
      return Object.freeze([...collections.values()].sort(compareCollections));
    },
    async saveCollection(input) {
      const parsed = parseCollection(input);
      collections.set(parsed.id, parsed);
      return parsed;
    },
    async deleteCollection(id) {
      return collections.delete(id);
    },
    async listEnvironments() {
      return Object.freeze([...environments.values()]);
    },
    async saveEnvironment(input) {
      const parsed = parseEnvironment(input);
      environments.set(parsed.id, parsed);
      return parsed;
    },
    async deleteEnvironment(id) {
      return environments.delete(id);
    },
  };
}

function createMongoStore(ownerId: string): Store {
  async function collectionsFor(name: 'collections' | 'environments') {
    const db = await getDb();
    const handle = db.collection<OwnedDoc>(name);
    // Owner first in the index: every query filters on it, so it belongs at
    // the front of the key for the index to be usable.
    await handle.createIndex({ ownerId: 1, id: 1 }, { unique: true });
    return handle;
  }

  return {
    async ensureSamples() {
      const db = await getDb();
      const workspaces = db.collection<{ ownerId: string; seededAt: Date }>(
        'workspace_meta',
      );
      await workspaces.createIndex({ ownerId: 1 }, { unique: true });

      /*
       * The marker is what makes this once-only. Someone who deleted the
       * samples must not find them back on the next load, so an existing
       * marker ends it here — including for an owner seeded by an earlier
       * build, who keeps the workspace they have rather than being handed
       * five more collections without asking.
       */
      if (await workspaces.findOne({ ownerId })) return;

      /*
       * Write the collections before the marker. If a write fails, the next
       * request retries rather than recording a half-finished setup. A
       * concurrent first load may perform the same upserts twice, which is
       * harmless because (ownerId, id) is unique.
       */
      const handle = await collectionsFor('collections');
      await Promise.all(
        SAMPLE_COLLECTIONS.map((collection) =>
          handle.replaceOne(
            { ownerId, id: collection.id },
            { ...collection, ownerId },
            { upsert: true },
          ),
        ),
      );
      await workspaces.updateOne(
        { ownerId },
        { $setOnInsert: { ownerId, seededAt: new Date() } },
        { upsert: true },
      );
    },

    async listCollections() {
      const handle = await collectionsFor('collections');
      const docs = await handle
        .find(
          { ownerId },
          // Seeded collections carry a position and keep their reading order;
          // a collection someone made has none and sorts first, by name.
          { sort: { order: 1, name: 1 }, projection: { _id: 0, ownerId: 0 } },
        )
        .toArray();
      // Revalidated on read: a document written by an older build must not be
      // able to produce a malformed outbound request.
      return Object.freeze(docs.map((doc) => parseCollection(doc)));
    },

    async saveCollection(input) {
      const parsed = parseCollection(input);
      const handle = await collectionsFor('collections');
      await handle.replaceOne(
        { ownerId, id: parsed.id },
        { ...parsed, ownerId },
        { upsert: true },
      );
      return parsed;
    },

    async deleteCollection(id) {
      const handle = await collectionsFor('collections');
      // Owner is in the filter, so one user cannot delete another's document
      // by guessing its id.
      const result = await handle.deleteOne({ ownerId, id });
      return result.deletedCount > 0;
    },

    async listEnvironments() {
      const handle = await collectionsFor('environments');
      const docs = await handle
        .find({ ownerId }, { sort: { name: 1 }, projection: { _id: 0, ownerId: 0 } })
        .toArray();
      return Object.freeze(docs.map((doc) => parseEnvironment(doc)));
    },

    async saveEnvironment(input) {
      const parsed = parseEnvironment(input);
      const handle = await collectionsFor('environments');
      await handle.replaceOne(
        { ownerId, id: parsed.id },
        { ...parsed, ownerId },
        { upsert: true },
      );
      return parsed;
    },

    async deleteEnvironment(id) {
      const handle = await collectionsFor('environments');
      const result = await handle.deleteOne({ ownerId, id });
      return result.deletedCount > 0;
    },
  };
}

export function getStoreKind(useDatabase: boolean): StoreKind {
  return useDatabase ? 'mongodb' : 'memory';
}

/**
 * Builds a store bound to one owner. The owner cannot be changed afterwards.
 *
 * `useDatabase` is passed in rather than inferred, because the caller is the
 * only one that knows whether the cluster is actually reachable. Inferring it
 * from the presence of a connection string would hand back a Mongo store that
 * throws on every call when the database is down.
 */
export function getStore(ownerId: string, useDatabase: boolean): Store {
  if (!ownerId) throw new Error('getStore requires an ownerId');
  if (useDatabase) return createMongoStore(ownerId);

  // Cached per owner on globalThis: Next reloads the module graph on edit in
  // development, and a fresh Map each time would discard the user's work.
  const scope = globalThis as GlobalCache;
  scope[MEMORY_KEY] ??= new Map<string, Store>();
  const existing = scope[MEMORY_KEY].get(ownerId);
  if (existing) return existing;

  const created = createMemoryStore();
  scope[MEMORY_KEY].set(ownerId, created);
  return created;
}

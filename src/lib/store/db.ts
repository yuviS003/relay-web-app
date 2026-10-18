import { MongoClient, type Db } from 'mongodb';

/*
 * One Mongo client for the process, shared by the workspace store and the auth
 * module. Creating a client per request is the standard way a serverless app
 * exhausts the Atlas Free connection cap of 500, and two modules each building
 * their own pool would halve the headroom for no benefit.
 */
const CLIENT_KEY = '__wac_mongo_client__';

type GlobalCache = typeof globalThis & {
  [CLIENT_KEY]?: Promise<MongoClient>;
};

export function hasDatabase(): boolean {
  return typeof process.env.MONGODB_URI === 'string' && process.env.MONGODB_URI !== '';
}

export function databaseName(): string {
  return process.env.MONGODB_DB ?? 'web_api_client';
}

export function getClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured');

  const scope = globalThis as GlobalCache;
  scope[CLIENT_KEY] ??= new MongoClient(uri, {
    maxPoolSize: 5,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 8_000,
  }).connect();
  return scope[CLIENT_KEY];
}

export async function getDb(): Promise<Db> {
  return (await getClient()).db(databaseName());
}

export class DatabaseUnavailableError extends Error {
  readonly hint: string;

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);

    /*
     * Atlas reports an IP that is not in its Network Access list by accepting
     * the TCP connection and then failing the TLS handshake. The driver
     * surfaces that as a certificate error, which sends people hunting for a
     * TLS misconfiguration that does not exist. Name the real cause here so
     * the message in the UI is actionable.
     */
    const blockedByAllowlist = /tlsv1 alert internal error|ssl3_read_bytes/i.test(
      message,
    );

    super('The database is unreachable');
    this.name = 'DatabaseUnavailableError';
    this.hint = blockedByAllowlist
      ? 'The connection was accepted and then the TLS handshake was rejected, which is how MongoDB Atlas reports an IP address that is not in its Network Access list. Add your current IP in Atlas under Network Access.'
      : message.split('\n')[0] ?? message;
    this.cause = cause;
  }
}

/**
 * Cheap reachability check with a cached answer.
 *
 * Every request re-testing the cluster would add a round trip to the critical
 * path, and a failing cluster would add the full timeout. The result is cached
 * briefly so a recovered database is picked up without a restart, and a broken
 * one is not probed on every keystroke.
 */
const PROBE_TTL_MS = 15_000;
let probe: { at: number; reachable: boolean } | null = null;

export async function databaseReachable(): Promise<boolean> {
  if (!hasDatabase()) return false;

  const now = Date.now();
  if (probe && now - probe.at < PROBE_TTL_MS) return probe.reachable;

  try {
    const client = await getClient();
    await client.db().admin().ping();
    probe = { at: now, reachable: true };
    return true;
  } catch {
    probe = { at: now, reachable: false };
    return false;
  }
}

/** Forgets the cached probe, so the next check talks to the cluster. */
export function resetDatabaseProbe(): void {
  probe = null;
}

import { authMode, currentUser } from '@/lib/auth';
import { getStore, getStoreKind, SAMPLE_COLLECTIONS, type Store } from '@/lib/store';
import type { AuthMode } from '@/lib/auth';

/*
 * Collections and environments. One endpoint for both, because the UI always
 * loads them together and a second round trip buys nothing.
 *
 * Every handler resolves the caller first and builds a store bound to that
 * owner. The store has no unscoped read, so a missing check here cannot leak
 * another user's collections: there is no query to run without an owner.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolves the caller, or an error response when there is no session. In local
 * mode (no database) this always succeeds with a fixed local owner.
 */
async function requireStore(
  request: Request,
): Promise<{ store: Store; ownerId: string; mode: AuthMode } | Response> {
  const mode = await authMode();
  const user = await currentUser(request.headers.get('cookie'));

  if (!user) {
    return Response.json(
      { error: 'Sign in to use the workspace', mode },
      { status: 401 },
    );
  }

  // Only use the database when it is genuinely reachable; otherwise the
  // workspace runs in memory so the tool stays usable.
  return { store: getStore(user.id, mode === 'accounts'), ownerId: user.id, mode };
}

export async function GET(request: Request): Promise<Response> {
  const mode = await authMode();
  const user = await currentUser(request.headers.get('cookie'));

  // In account mode an unsigned caller is a guest: the sample workspace is
  // returned as an immutable preview — the same collections a new account is
  // seeded with, so a visitor can try every feature and only needs to sign in
  // to keep changes. Mutations still go through requireStore below and receive
  // 401, so browsing and relaying need no account while persistence remains
  // account-only.
  if (mode === 'accounts' && !user) {
    return Response.json({
      storeKind: 'memory',
      mode: 'guest',
      readOnly: true,
      collections: SAMPLE_COLLECTIONS,
      environments: [],
    });
  }

  const resolved = await requireStore(request);
  if (resolved instanceof Response) return resolved;
  const { store } = resolved;
  try {
    await store.ensureSamples();
    const [collections, environments] = await Promise.all([
      store.listCollections(),
      store.listEnvironments(),
    ]);
    return Response.json({
      storeKind: getStoreKind(mode === 'accounts'),
      mode,
      collections,
      environments,
    });
  } catch (error) {
    return Response.json(
      {
        error: 'Workspace could not be loaded',
        detail: error instanceof Error ? error.message : String(error),
        storeKind: 'memory',
      },
      { status: 503 },
    );
  }
}

export async function PUT(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const resolved = await requireStore(request);
  if (resolved instanceof Response) return resolved;
  const { store } = resolved;

  const { kind, value } = body as { kind?: unknown; value?: unknown };

  try {
    if (kind === 'collection') {
      return Response.json({ saved: await store.saveCollection(value) });
    }
    if (kind === 'environment') {
      return Response.json({ saved: await store.saveEnvironment(value) });
    }
    return Response.json(
      { error: "kind must be 'collection' or 'environment'" },
      { status: 400 },
    );
  } catch (error) {
    // Validation failures are the caller's fault, so they get 422 and the
    // specific reason rather than a generic 500.
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid payload' },
      { status: 422 },
    );
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const id = url.searchParams.get('id');

  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

  const resolved = await requireStore(request);
  if (resolved instanceof Response) return resolved;
  const { store } = resolved;
  const removed =
    kind === 'collection'
      ? await store.deleteCollection(id)
      : kind === 'environment'
        ? await store.deleteEnvironment(id)
        : null;

  if (removed === null) {
    return Response.json(
      { error: "kind must be 'collection' or 'environment'" },
      { status: 400 },
    );
  }
  if (!removed) return Response.json({ error: 'Not found' }, { status: 404 });

  return Response.json({ removed: id });
}

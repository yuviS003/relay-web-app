import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Db, Collection as MongoCollection } from 'mongodb';

/*
 * Passkeys (WebAuthn), as a second factor and as a way in.
 *
 * This is the one place a dependency is clearly right. The rest of the auth
 * code here is written from the specifications because those specifications
 * are an HMAC and a modulo; WebAuthn registration verification is CBOR
 * decoding, COSE key parsing, attestation statement formats and signature
 * verification across several algorithms. Hand-rolling that would be a
 * liability, not a demonstration.
 *
 * What is still ours, because it is where the mistakes live:
 *  - the challenge is stored server-side, single use, and expires;
 *  - the credential id, public key and signature counter are persisted, and a
 *    counter that fails to advance is treated as a cloned authenticator;
 *  - the relying party id is derived from the request origin, so a deployment
 *    on another host cannot be replayed against this one.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type PasskeyRecord = {
  credentialId: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

type ChallengeRecord = {
  challenge: string;
  userId: string;
  kind: 'register' | 'authenticate';
  createdAt: Date;
  expiresAt: Date;
};

export async function passkeys(db: Db): Promise<MongoCollection<PasskeyRecord>> {
  const collection = db.collection<PasskeyRecord>('passkeys');
  await collection.createIndex({ credentialId: 1 }, { unique: true });
  await collection.createIndex({ userId: 1 });
  return collection;
}

async function challenges(db: Db): Promise<MongoCollection<ChallengeRecord>> {
  const collection = db.collection<ChallengeRecord>('passkey_challenges');
  await collection.createIndex({ userId: 1, kind: 1 });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return collection;
}

/**
 * The relying party is the host, not a configured string.
 *
 * A passkey is bound to its relying party id, so taking it from the request
 * means a credential registered on this deployment cannot be presented to a
 * different one — and it keeps localhost working without configuration.
 */
export function relyingParty(request: Request): { id: string; origin: string } {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost ?? request.headers.get('host') ?? 'localhost';
  const proto =
    request.headers.get('x-forwarded-proto') ??
    new URL(request.url).protocol.replace(':', '');
  const hostname = host.split(':')[0] ?? 'localhost';
  return { id: hostname, origin: `${proto}://${host}` };
}

async function storeChallenge(
  db: Db,
  userId: string,
  kind: ChallengeRecord['kind'],
  challenge: string,
): Promise<void> {
  const collection = await challenges(db);
  // One outstanding challenge per purpose: a second request invalidates the
  // first rather than leaving two valid ones.
  await collection.deleteMany({ userId, kind });
  const now = new Date();
  await collection.insertOne({
    challenge,
    userId,
    kind,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });
}

async function takeChallenge(
  db: Db,
  userId: string,
  kind: ChallengeRecord['kind'],
): Promise<string | null> {
  const collection = await challenges(db);
  // Read and delete together: a challenge must be usable exactly once.
  const record = await collection.findOneAndDelete({ userId, kind });
  if (!record) return null;
  return record.expiresAt.getTime() < Date.now() ? null : record.challenge;
}

export async function beginPasskeyRegistration(
  db: Db,
  request: Request,
  user: { id: string; email: string },
): Promise<Record<string, unknown>> {
  const rp = relyingParty(request);
  const existing = await (await passkeys(db)).find({ userId: user.id }).toArray();

  const options = await generateRegistrationOptions({
    rpName: 'Relay',
    rpID: rp.id,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    // Already-registered credentials are excluded so the authenticator says
    // "you already have one" instead of silently creating a duplicate.
    excludeCredentials: existing.map((record) => ({
      id: record.credentialId,
      transports: record.transports as never,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  await storeChallenge(db, user.id, 'register', options.challenge);
  return options as unknown as Record<string, unknown>;
}

export async function finishPasskeyRegistration(
  db: Db,
  request: Request,
  user: { id: string },
  response: unknown,
  label: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const challenge = await takeChallenge(db, user.id, 'register');
  if (!challenge) return { ok: false, error: 'That registration expired. Try again.' };

  const rp = relyingParty(request);
  try {
    const verification = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return { ok: false, error: 'That passkey could not be verified' };
    }

    const { credential } = verification.registrationInfo;
    const collection = await passkeys(db);
    await collection.insertOne({
      credentialId: credential.id,
      userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: (credential.transports ?? []) as string[],
      label: label.trim() === '' ? 'Passkey' : label.trim().slice(0, 60),
      createdAt: new Date(),
      lastUsedAt: null,
    });

    return { ok: true, label };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Registration failed',
    };
  }
}

/*
 * There is deliberately no per-user authentication variant here.
 *
 * Asking for the account first, then offering its credential list, would make
 * the sign-in form answer "does this address have a passkey?" — an
 * enumeration oracle. The discoverable flow below needs no email, so it cannot
 * be asked that question.
 */

export async function listPasskeys(
  db: Db,
  userId: string,
): Promise<{ credentialId: string; label: string; createdAt: string; lastUsedAt: string | null }[]> {
  const collection = await passkeys(db);
  const records = await collection.find({ userId }).toArray();
  return records.map((record) => ({
    credentialId: record.credentialId,
    label: record.label,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function removePasskey(
  db: Db,
  userId: string,
  credentialId: string,
): Promise<boolean> {
  const collection = await passkeys(db);
  const result = await collection.deleteOne({ userId, credentialId });
  return (result.deletedCount ?? 0) > 0;
}

/* ---------------------------------------------------------------------------
 * Passwordless sign-in with a discoverable credential.
 *
 * No email is asked for, and no credential list is returned, which is the
 * point: a flow that answered "this address has a passkey" would be an account
 * enumeration oracle. The authenticator offers whatever it holds for this
 * site, and the credential it signs with tells the server who signed in.
 *
 * The challenge is filed under an opaque handle that the caller holds in an
 * HttpOnly cookie, so it is single use and cannot be claimed by anyone else.
 * ------------------------------------------------------------------------- */

export async function beginDiscoverablePasskeyAuthentication(
  db: Db,
  request: Request,
  handle: string,
): Promise<Record<string, unknown>> {
  const rp = relyingParty(request);
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: 'preferred',
    // Empty on purpose: the authenticator picks, so nothing is revealed.
    allowCredentials: [],
  });
  await storeChallenge(db, `handle:${handle}`, 'authenticate', options.challenge);
  return options as unknown as Record<string, unknown>;
}

export async function finishDiscoverablePasskeyAuthentication(
  db: Db,
  request: Request,
  handle: string,
  response: unknown,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const challenge = await takeChallenge(db, `handle:${handle}`, 'authenticate');
  if (!challenge) return { ok: false, error: 'That sign-in expired. Try again.' };

  const credentialId =
    typeof response === 'object' && response !== null && 'id' in response
      ? String((response as { id: unknown }).id)
      : '';
  if (credentialId === '') return { ok: false, error: 'No credential was presented' };

  const collection = await passkeys(db);
  const record = await collection.findOne({ credentialId });
  // The same message either way: whether this credential is registered here is
  // not something an unauthenticated caller should be able to probe.
  if (!record) return { ok: false, error: 'That passkey could not be verified' };

  const rp = relyingParty(request);
  try {
    const verification = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
      credential: {
        id: record.credentialId,
        publicKey: new Uint8Array(Buffer.from(record.publicKey, 'base64url')),
        counter: record.counter,
        transports: record.transports as never,
      },
    });
    if (!verification.verified) {
      return { ok: false, error: 'That passkey could not be verified' };
    }

    const next = verification.authenticationInfo.newCounter;
    if (record.counter > 0 && next <= record.counter) {
      return { ok: false, error: 'That passkey looks cloned and was refused' };
    }

    await collection.updateOne(
      { credentialId: record.credentialId },
      { $set: { counter: next, lastUsedAt: new Date() } },
    );
    return { ok: true, userId: record.userId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    };
  }
}

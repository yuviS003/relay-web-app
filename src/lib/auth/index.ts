import { randomUUID } from 'node:crypto';
import type { Collection as MongoCollection, Db } from 'mongodb';

import {
  databaseReachable,
  DatabaseUnavailableError,
  getDb,
  hasDatabase,
} from '../store/db';
import { hashPassword, verifyPassword, checkPasswordStrength } from './passwords';
import {
  consumeRecoveryCode,
  createRecoveryCodes,
  isRecoveryCodeShaped,
} from './recovery';
import {
  buildChallengeRecord,
  buildSessionRecord,
  createSessionToken,
  hashSessionToken,
  normaliseEmail,
  readSessionToken,
  type SessionRecord,
} from './sessions';
import { listPasskeys } from './passkeys';
import {
  createTotpSecret,
  isTotpCodeShaped,
  otpauthUri,
  verifyTotp,
} from './totp';

/*
 * Accounts.
 *
 * Auth needs somewhere to persist users, so it is only available when a
 * database is configured. Without MONGODB_URI the app runs in local mode: one
 * unauthenticated workspace on this machine. That is a deliberate split rather
 * than a half-built login — a fake account system that forgets you on restart
 * is worse than none.
 */

export const LOCAL_OWNER = 'local';

/**
 * 'accounts'  a database is configured and reachable; sign-in is required.
 * 'local'     no database configured; one unauthenticated local workspace.
 * 'degraded'  a database is configured but unreachable. The app still works
 *             on an in-memory workspace so it is usable, and the UI says
 *             clearly that nothing will persist.
 */
export type AuthMode = 'accounts' | 'local' | 'degraded';

export async function authMode(): Promise<AuthMode> {
  if (!hasDatabase()) return 'local';
  return (await databaseReachable()) ? 'accounts' : 'degraded';
}

export type OAuthProvider = 'google' | 'github';
export type OAuthAccount = { provider: OAuthProvider; subject: string };

/** An active second factor. `lastStep` is the replay guard for TOTP. */
export type MfaState = {
  secret: string;
  enabledAt: Date;
  lastStep?: number;
  recoveryHashes: string[];
};

export type UserRecord = {
  id: string;
  email: string;
  passwordHash?: string;
  oauthAccounts?: OAuthAccount[];
  createdAt: Date;
  mfa?: MfaState;
  /** Set while enrolling, before a code has proven the app is in sync. */
  mfaPendingSecret?: string;
  /** The nudge to turn MFA on was declined; do not ask again on sign-in. */
  mfaPromptSkipped?: boolean;
  tourDoneAt?: Date;
};

export type PublicUser = {
  id: string;
  email: string;
  mfaEnabled: boolean;
  /** Whether to offer the optional second-factor setup after signing in. */
  offerMfa: boolean;
  tourDone: boolean;
  hasPassword: boolean;
};

export type AuthOutcome =
  | { ok: true; user: PublicUser; token: string }
  /** Password accepted, second factor outstanding. Carries no session. */
  | { ok: true; mfaRequired: true; challengeToken: string }
  | { ok: false; error: string; status: 400 | 401 | 409 | 503 };

export type ActionOutcome =
  | { ok: true }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 503 };

function publicUser(record: UserRecord): PublicUser {
  return {
    id: record.id,
    email: record.email,
    mfaEnabled: Boolean(record.mfa),
    offerMfa: !record.mfa && record.mfaPromptSkipped !== true,
    tourDone: Boolean(record.tourDoneAt),
    hasPassword: typeof record.passwordHash === 'string',
  };
}

async function users(db: Db): Promise<MongoCollection<UserRecord>> {
  const collection = db.collection<UserRecord>('users');
  // Unique on email so two signups cannot race into duplicate accounts; the
  // application check alone loses that race under concurrency.
  await collection.createIndex({ email: 1 }, { unique: true });
  await collection.createIndex(
    { 'oauthAccounts.provider': 1, 'oauthAccounts.subject': 1 },
    { sparse: true },
  );
  return collection;
}

async function sessions(db: Db): Promise<MongoCollection<SessionRecord>> {
  const collection = db.collection<SessionRecord>('sessions');
  await collection.createIndex({ tokenHash: 1 }, { unique: true });
  // Mongo removes expired sessions on its own, so logout-by-expiry needs no
  // cron and a stale session cannot linger if the app never looks at it.
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return collection;
}

export async function signUp(
  emailInput: unknown,
  password: unknown,
): Promise<AuthOutcome> {
  if (!hasDatabase()) {
    return { ok: false, error: 'Accounts need a configured database', status: 503 };
  }

  const email = normaliseEmail(emailInput);
  if (!email) return { ok: false, error: 'Enter a valid email address', status: 400 };
  if (typeof password !== 'string') {
    return { ok: false, error: 'Password is required', status: 400 };
  }

  const problem = checkPasswordStrength(password);
  if (problem) {
    const message =
      problem === 'too-short'
        ? 'Use at least 10 characters'
        : problem === 'too-common'
          ? 'That password is too common'
          : problem === 'too-long'
            ? 'That password is too long'
            : 'Password cannot be blank';
    return { ok: false, error: message, status: 400 };
  }

  let db;
  try {
    db = await getDb();
  } catch (error) {
    const unavailable = new DatabaseUnavailableError(error);
    return { ok: false, error: unavailable.hint, status: 503 };
  }

  const collection = await users(db);
  const record: UserRecord = {
    id: randomUUID(),
    email,
    passwordHash: await hashPassword(password),
    createdAt: new Date(),
  };

  try {
    await collection.insertOne(record);
  } catch (error) {
    // Duplicate key from the unique index: the account already exists.
    if ((error as { code?: number }).code === 11000) {
      return { ok: false, error: 'That email is already registered', status: 409 };
    }
    throw error;
  }

  const token = await openSession(record.id);
  return { ok: true, user: publicUser(record), token };
}

export async function signIn(
  emailInput: unknown,
  password: unknown,
): Promise<AuthOutcome> {
  if (!hasDatabase()) {
    return { ok: false, error: 'Accounts need a configured database', status: 503 };
  }

  const email = normaliseEmail(emailInput);

  let db;
  try {
    db = await getDb();
  } catch (error) {
    const unavailable = new DatabaseUnavailableError(error);
    return { ok: false, error: unavailable.hint, status: 503 };
  }

  const collection = await users(db);
  const record = email ? await collection.findOne({ email }) : null;

  /*
   * One message for both "no such account" and "wrong password", and the hash
   * comparison runs even when the user does not exist. Distinguishing them
   * would turn this endpoint into an account enumeration oracle, and returning
   * early would leak the same information through response timing.
   */
  const stored =
    record?.passwordHash ??
    '$scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88);
  const valid =
    typeof password === 'string' ? await verifyPassword(password, stored) : false;

  if (!record || !valid) {
    return { ok: false, error: 'Email or password is incorrect', status: 401 };
  }

  if (record.mfa) {
    return {
      ok: true,
      mfaRequired: true,
      challengeToken: await openMfaChallenge(record.id),
    };
  }

  const token = await openSession(record.id);
  return { ok: true, user: publicUser(record), token };
}

/**
 * Finishes a sign-in that stopped at the second factor.
 *
 * Accepts a TOTP code or one recovery code. The challenge is spent either way:
 * a failed attempt does not invalidate it (that would make a typo a dead end),
 * but a success deletes it so the half-authenticated token cannot be reused.
 */
export async function completeMfaChallenge(
  challengeToken: string | null,
  code: unknown,
): Promise<AuthOutcome> {
  if (!hasDatabase()) {
    return { ok: false, error: 'Accounts need a configured database', status: 503 };
  }
  if (!challengeToken) {
    return { ok: false, error: 'Start again from the sign-in form', status: 401 };
  }

  let db;
  try {
    db = await getDb();
  } catch (error) {
    return { ok: false, error: new DatabaseUnavailableError(error).hint, status: 503 };
  }

  const sessionCollection = await sessions(db);
  const challenge = await sessionCollection.findOne({
    tokenHash: hashSessionToken(challengeToken),
    pendingMfa: true,
  });
  if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'That sign-in expired. Try again.', status: 401 };
  }

  // Garbage never reaches the database: anything that is neither a six-digit
  // code nor a recovery code cannot match either branch below.
  if (!isTotpCodeShaped(code) && !isRecoveryCodeShaped(code)) {
    return { ok: false, error: 'That code is not valid', status: 401 };
  }

  const userCollection = await users(db);
  const record = await userCollection.findOne({ id: challenge.userId });
  if (!record?.mfa) {
    return { ok: false, error: 'Start again from the sign-in form', status: 401 };
  }

  const step = verifyTotp(record.mfa.secret, code, { after: record.mfa.lastStep });
  if (step !== null) {
    // Remembering the step is what stops a code from being replayed inside
    // the 30 seconds it remains otherwise valid.
    await userCollection.updateOne(
      { id: record.id },
      { $set: { 'mfa.lastStep': step } },
    );
  } else {
    const remaining = consumeRecoveryCode(record.mfa.recoveryHashes, code);
    if (!remaining) {
      return { ok: false, error: 'That code is not valid', status: 401 };
    }
    await userCollection.updateOne(
      { id: record.id },
      { $set: { 'mfa.recoveryHashes': remaining } },
    );
  }

  await sessionCollection.deleteOne({ tokenHash: challenge.tokenHash });
  const token = await openSession(record.id);
  return { ok: true, user: publicUser(record), token };
}

/**
 * Signs in a verified OAuth profile. Provider adapters call this only after
 * validating state and obtaining a provider-verified email address.
 */
export async function signInWithOAuth(
  provider: OAuthProvider,
  subject: string,
  emailInput: string,
): Promise<AuthOutcome> {
  if (!hasDatabase()) {
    return { ok: false, error: 'OAuth needs a configured database', status: 503 };
  }
  const email = normaliseEmail(emailInput);
  if (!email || subject.trim() === '') {
    return { ok: false, error: 'OAuth provider returned an invalid profile', status: 400 };
  }

  let db;
  try {
    db = await getDb();
  } catch (error) {
    return { ok: false, error: new DatabaseUnavailableError(error).hint, status: 503 };
  }
  const collection = await users(db);
  const account = { provider, subject } satisfies OAuthAccount;
  let record: UserRecord | null = await collection.findOne({
    oauthAccounts: { $elemMatch: { provider, subject } },
  });

  if (!record) {
    record = await collection.findOne({ email });
    if (record) {
      await collection.updateOne(
        { id: record.id },
        { $addToSet: { oauthAccounts: account } },
      );
      record.oauthAccounts = [...(record.oauthAccounts ?? []), account];
    } else {
      record = {
        id: randomUUID(),
        email,
        oauthAccounts: [account],
        createdAt: new Date(),
      };
      try {
        await collection.insertOne(record);
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        const raced = await collection.findOne({ email });
        if (!raced) throw error;
        record = raced;
        await collection.updateOne(
          { id: record.id },
          { $addToSet: { oauthAccounts: account } },
        );
      }
    }
  }

  /*
   * A provider sign-in still faces the second factor. The provider proves the
   * email address; it does not prove the person holds this account's factor,
   * and someone who enables MFA here expects it to apply to every door.
   */
  if (record.mfa) {
    return {
      ok: true,
      mfaRequired: true,
      challengeToken: await openMfaChallenge(record.id),
    };
  }

  const token = await openSession(record.id);
  return { ok: true, user: publicUser(record), token };
}

/**
 * Opens a session for an account that proved itself with a passkey.
 *
 * No second factor afterwards. A passkey is bound to this origin and unlocked
 * by the device, so it already carries what a TOTP code is there to add;
 * asking for both would be ceremony, not security.
 */
export async function signInWithPasskey(userId: string): Promise<AuthOutcome> {
  if (!hasDatabase()) {
    return { ok: false, error: 'Accounts need a configured database', status: 503 };
  }
  let db: Db;
  try {
    db = await getDb();
  } catch (error) {
    return { ok: false, error: new DatabaseUnavailableError(error).hint, status: 503 };
  }
  const collection = await users(db);
  const record = await collection.findOne({ id: userId });
  if (!record) return { ok: false, error: 'That account no longer exists', status: 401 };

  const token = await openSession(record.id);
  return { ok: true, user: publicUser(record), token };
}

/** The database handle, for the routes that manage passkeys. */
export async function accountDb(): Promise<Db> {
  return getDb();
}

async function openSession(userId: string): Promise<string> {
  const db = await getDb();
  const collection = await sessions(db);
  const { token, tokenHash } = createSessionToken();
  await collection.insertOne(buildSessionRecord(userId, tokenHash));
  return token;
}

async function openMfaChallenge(userId: string): Promise<string> {
  const db = await getDb();
  const collection = await sessions(db);
  const { token, tokenHash } = createSessionToken();
  await collection.insertOne(buildChallengeRecord(userId, tokenHash));
  return token;
}

export async function signOut(cookieHeader: string | null): Promise<void> {
  if (!hasDatabase()) return;
  const token = readSessionToken(cookieHeader);
  if (!token) return;

  try {
    const db = await getDb();
    const collection = await sessions(db);
    // Deleting the record is what makes an opaque token revocable, which a
    // self-contained JWT would not be.
    await collection.deleteOne({ tokenHash: hashSessionToken(token) });
  } catch {
    // Signing out must always clear the cookie, even if the database is down.
  }
}

/**
 * Resolves the caller.
 *
 * In local mode there is no account system, so this returns a fixed local
 * owner. With a database it returns null unless a live session cookie is
 * present, and route handlers treat null as unauthenticated.
 */
export async function currentUser(
  cookieHeader: string | null,
): Promise<PublicUser | null> {
  // No database, or a database that cannot be reached: fall back to the local
  // workspace so the tool remains usable. The UI surfaces which mode is live.
  if (!hasDatabase() || !(await databaseReachable())) {
    return {
      id: LOCAL_OWNER,
      email: 'local',
      mfaEnabled: false,
      offerMfa: false,
      tourDone: false,
      hasPassword: false,
    };
  }

  const record = await userForSession(readSessionToken(cookieHeader));
  return record ? publicUser(record) : null;
}

/**
 * The account behind a session token, or null.
 *
 * `pendingMfa: { $ne: true }` is the load-bearing clause: a challenge token
 * names a real user, so without it a half-finished sign-in would resolve to a
 * signed-in caller and the second factor would be decoration.
 */
async function userForSession(token: string | null): Promise<UserRecord | null> {
  if (!token) return null;

  const db = await getDb();
  const sessionCollection = await sessions(db);
  const session = await sessionCollection.findOne({
    tokenHash: hashSessionToken(token),
    pendingMfa: { $ne: true },
  });

  // Checked in the application as well as by the TTL index: the index sweeps
  // on a background schedule, so an expired document can still be present.
  if (!session || session.expiresAt.getTime() < Date.now()) return null;

  const userCollection = await users(db);
  return userCollection.findOne({ id: session.userId });
}

/* ---------------------------------------------------------------------------
 * Account management. Every function here takes the caller's session token
 * rather than a user id, so a route cannot accidentally act on someone else by
 * passing an id from a request body.
 * ------------------------------------------------------------------------- */

export type AccountOverview = {
  user: PublicUser;
  createdAt: string;
  signInMethods: ('password' | OAuthProvider)[];
  mfa: { enabled: boolean; enabledAt: string | null; recoveryRemaining: number };
  passkeys: {
    credentialId: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
  otherSessions: number;
};

async function withAccount<T>(
  cookieHeader: string | null,
  handler: (record: UserRecord, db: Db, token: string) => Promise<T>,
): Promise<T | { ok: false; error: string; status: 401 | 503 }> {
  if (!hasDatabase()) {
    return { ok: false, error: 'Accounts need a configured database', status: 503 };
  }
  const token = readSessionToken(cookieHeader);
  let db: Db;
  try {
    db = await getDb();
  } catch (error) {
    return { ok: false, error: new DatabaseUnavailableError(error).hint, status: 503 };
  }
  const record = await userForSession(token);
  if (!record || !token) {
    return { ok: false, error: 'Sign in first', status: 401 };
  }
  return handler(record, db, token);
}

export async function accountOverview(
  cookieHeader: string | null,
): Promise<AccountOverview | { ok: false; error: string; status: number }> {
  return withAccount(cookieHeader, async (record, db, token) => {
    const sessionCollection = await sessions(db);
    const otherSessions = await sessionCollection.countDocuments({
      userId: record.id,
      pendingMfa: { $ne: true },
      tokenHash: { $ne: hashSessionToken(token) },
    });

    return {
      user: publicUser(record),
      createdAt: record.createdAt.toISOString(),
      signInMethods: [
        ...(record.passwordHash ? (['password'] as const) : []),
        ...(record.oauthAccounts ?? []).map((account) => account.provider),
      ],
      mfa: {
        enabled: Boolean(record.mfa),
        enabledAt: record.mfa?.enabledAt.toISOString() ?? null,
        recoveryRemaining: record.mfa?.recoveryHashes.length ?? 0,
      },
      passkeys: await listPasskeys(db, record.id),
      otherSessions,
    };
  });
}

/**
 * Begins enrollment. The secret is stored separately from the active factor
 * until a code proves the authenticator actually has it — otherwise a mistyped
 * setup locks the account out of its own second factor.
 */
export async function startMfaSetup(
  cookieHeader: string | null,
): Promise<
  { ok: true; secret: string; uri: string } | { ok: false; error: string; status: number }
> {
  return withAccount(cookieHeader, async (record, db) => {
    if (record.mfa) {
      return {
        ok: false as const,
        error: 'Two-factor authentication is already on',
        status: 400 as const,
      };
    }
    const secret = createTotpSecret();
    const collection = await users(db);
    await collection.updateOne(
      { id: record.id },
      { $set: { mfaPendingSecret: secret } },
    );
    return { ok: true as const, secret, uri: otpauthUri(record.email, secret) };
  });
}

export async function confirmMfaSetup(
  cookieHeader: string | null,
  code: unknown,
): Promise<
  { ok: true; codes: string[] } | { ok: false; error: string; status: number }
> {
  return withAccount(cookieHeader, async (record, db) => {
    if (record.mfa) {
      return {
        ok: false as const,
        error: 'Two-factor authentication is already on',
        status: 400 as const,
      };
    }
    const secret = record.mfaPendingSecret;
    if (!secret) {
      return {
        ok: false as const,
        error: 'Start the setup again',
        status: 400 as const,
      };
    }
    const step = verifyTotp(secret, code);
    if (step === null) {
      return {
        ok: false as const,
        error: 'That code is not valid. Check the clock on your phone.',
        status: 400 as const,
      };
    }

    const { codes, hashes } = createRecoveryCodes();
    const collection = await users(db);
    await collection.updateOne(
      { id: record.id },
      {
        $set: {
          mfa: {
            secret,
            enabledAt: new Date(),
            lastStep: step,
            recoveryHashes: hashes,
          },
        },
        $unset: { mfaPendingSecret: '', mfaPromptSkipped: '' },
      },
    );
    return { ok: true as const, codes };
  });
}

/**
 * Proof that the person asking is the account holder, for the operations that
 * weaken it. A password when there is one; otherwise a current second factor,
 * which is all an OAuth-only account has to offer.
 */
async function reauthenticate(
  record: UserRecord,
  db: Db,
  proof: { password?: unknown; code?: unknown },
): Promise<boolean> {
  if (record.passwordHash) {
    return typeof proof.password === 'string'
      ? verifyPassword(proof.password, record.passwordHash)
      : false;
  }
  if (!record.mfa) return true;

  if (verifyTotp(record.mfa.secret, proof.code, { after: record.mfa.lastStep }) !== null) {
    return true;
  }
  const remaining = consumeRecoveryCode(record.mfa.recoveryHashes, proof.code);
  if (!remaining) return false;
  const collection = await users(db);
  await collection.updateOne(
    { id: record.id },
    { $set: { 'mfa.recoveryHashes': remaining } },
  );
  return true;
}

export async function disableMfa(
  cookieHeader: string | null,
  proof: { password?: unknown; code?: unknown },
): Promise<ActionOutcome | { ok: false; error: string; status: number }> {
  return withAccount(cookieHeader, async (record, db) => {
    if (!record.mfa) {
      return {
        ok: false as const,
        error: 'Two-factor authentication is already off',
        status: 400 as const,
      };
    }
    if (!(await reauthenticate(record, db, proof))) {
      return {
        ok: false as const,
        error: record.passwordHash
          ? 'That password is not correct'
          : 'That code is not valid',
        status: 401 as const,
      };
    }
    const collection = await users(db);
    await collection.updateOne(
      { id: record.id },
      {
        $unset: { mfa: '', mfaPendingSecret: '' },
        /*
         * Turning it off is a decision, so the sign-in nudge stays away
         * afterwards. Without this the offer reappeared the moment the switch
         * flipped — on top of the settings dialog that had just been used to
         * flip it. Settings can turn it back on at any time.
         */
        $set: { mfaPromptSkipped: true },
      },
    );
    return { ok: true as const };
  });
}

export async function regenerateRecoveryCodes(
  cookieHeader: string | null,
  proof: { password?: unknown; code?: unknown },
): Promise<
  { ok: true; codes: string[] } | { ok: false; error: string; status: number }
> {
  return withAccount(cookieHeader, async (record, db) => {
    if (!record.mfa) {
      return {
        ok: false as const,
        error: 'Turn on two-factor authentication first',
        status: 400 as const,
      };
    }
    if (!(await reauthenticate(record, db, proof))) {
      return {
        ok: false as const,
        error: record.passwordHash
          ? 'That password is not correct'
          : 'That code is not valid',
        status: 401 as const,
      };
    }
    const { codes, hashes } = createRecoveryCodes();
    const collection = await users(db);
    await collection.updateOne(
      { id: record.id },
      { $set: { 'mfa.recoveryHashes': hashes } },
    );
    return { ok: true as const, codes };
  });
}

/**
 * Changes, or first sets, the account password.
 *
 * Every other session is dropped on success. A password change is how someone
 * reacts to "I think another device has my account", so leaving those sessions
 * alive would make the fix useless.
 */
export async function changePassword(
  cookieHeader: string | null,
  current: unknown,
  next: unknown,
): Promise<ActionOutcome | { ok: false; error: string; status: number }> {
  return withAccount(cookieHeader, async (record, db, token) => {
    if (record.passwordHash) {
      const valid =
        typeof current === 'string'
          ? await verifyPassword(current, record.passwordHash)
          : false;
      if (!valid) {
        return {
          ok: false as const,
          error: 'That password is not correct',
          status: 401 as const,
        };
      }
    }

    if (typeof next !== 'string') {
      return { ok: false as const, error: 'Password is required', status: 400 as const };
    }
    const problem = checkPasswordStrength(next);
    if (problem) {
      return {
        ok: false as const,
        error:
          problem === 'too-short'
            ? 'Use at least 10 characters'
            : problem === 'too-common'
              ? 'That password is too common'
              : problem === 'too-long'
                ? 'That password is too long'
                : 'Password cannot be blank',
        status: 400 as const,
      };
    }

    const collection = await users(db);
    await collection.updateOne(
      { id: record.id },
      { $set: { passwordHash: await hashPassword(next) } },
    );
    const sessionCollection = await sessions(db);
    await sessionCollection.deleteMany({
      userId: record.id,
      tokenHash: { $ne: hashSessionToken(token) },
    });
    return { ok: true as const };
  });
}

/** Signs every other device out, keeping the caller's own session. */
export async function revokeOtherSessions(
  cookieHeader: string | null,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string; status: number }> {
  return withAccount(cookieHeader, async (record, db, token) => {
    const sessionCollection = await sessions(db);
    const { deletedCount } = await sessionCollection.deleteMany({
      userId: record.id,
      tokenHash: { $ne: hashSessionToken(token) },
    });
    return { ok: true as const, revoked: deletedCount ?? 0 };
  });
}

export async function setMfaPromptSkipped(
  cookieHeader: string | null,
): Promise<ActionOutcome | { ok: false; error: string; status: number }> {
  return withAccount(cookieHeader, async (record, db) => {
    const collection = await users(db);
    await collection.updateOne(
      { id: record.id },
      { $set: { mfaPromptSkipped: true } },
    );
    return { ok: true as const };
  });
}

/*
 * Everything this account owns, as JSON.
 *
 * The counterpart to deletion: a service that can delete your data should be
 * able to hand it to you first. Secret variables are exported as the
 * ciphertext they are stored as, because the key never left the browser —
 * stated in the file so an export is not mistaken for plaintext.
 */
export async function exportAccount(
  cookieHeader: string | null,
): Promise<Record<string, unknown> | { ok: false; error: string; status: number }> {
  return withAccount(cookieHeader, async (record, db) => {
    const collections = await db
      .collection('collections')
      .find({ ownerId: record.id })
      .project({ _id: 0, ownerId: 0 })
      .toArray();
    const environments = await db
      .collection('environments')
      .find({ ownerId: record.id })
      .project({ _id: 0, ownerId: 0 })
      .toArray();

    return {
      exportedAt: new Date().toISOString(),
      account: {
        email: record.email,
        createdAt: record.createdAt.toISOString(),
        signInMethods: [
          ...(record.passwordHash ? ['password'] : []),
          ...(record.oauthAccounts ?? []).map((account) => account.provider),
        ],
        twoFactor: record.mfa ? { enabledAt: record.mfa.enabledAt.toISOString() } : null,
      },
      collections,
      environments,
      notes: [
        'Secret environment values are ciphertext: they are encrypted in the browser with a passphrase this server never receives, so they can only be read back with that passphrase.',
        'Password hashes, session tokens and two-factor secrets are deliberately not exported.',
      ],
    };
  });
}

/**
 * Deletes the account and everything scoped to it.
 *
 * Requires the same proof as turning off a second factor, because it is the
 * most destructive thing the API offers. Sessions go first: once they are
 * gone, no half-finished request can write data back after the rest is
 * removed.
 */
export async function deleteAccount(
  cookieHeader: string | null,
  proof: { password?: unknown; code?: unknown },
): Promise<ActionOutcome | { ok: false; error: string; status: number }> {
  return withAccount(cookieHeader, async (record, db) => {
    if (!(await reauthenticate(record, db, proof))) {
      return {
        ok: false as const,
        error: record.passwordHash
          ? 'That password is not correct'
          : 'That code is not valid',
        status: 401 as const,
      };
    }

    const sessionCollection = await sessions(db);
    await sessionCollection.deleteMany({ userId: record.id });
    await Promise.all([
      db.collection('collections').deleteMany({ ownerId: record.id }),
      db.collection('environments').deleteMany({ ownerId: record.id }),
      db.collection('workspace_meta').deleteMany({ ownerId: record.id }),
      db.collection('password_resets').deleteMany({ userId: record.id }),
    ]);
    const userCollection = await users(db);
    await userCollection.deleteOne({ id: record.id });
    return { ok: true as const };
  });
}

/* ---------------------------------------------------------------------------
 * Password reset, for someone who cannot sign in at all.
 *
 * Opaque single-use token, hashed at rest like a session token, short expiry,
 * and the same answer whether or not the address has an account — otherwise
 * the form becomes a way to ask "is this person a user here?".
 * ------------------------------------------------------------------------- */

const RESET_TTL_MS = 30 * 60 * 1000;

type ResetRecord = {
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
};

async function resets(db: Db): Promise<MongoCollection<ResetRecord>> {
  const collection = db.collection<ResetRecord>('password_resets');
  await collection.createIndex({ tokenHash: 1 }, { unique: true });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return collection;
}

/**
 * Issues a reset token for an email address, if it has an account.
 *
 * Returns the token rather than sending it: delivery is the caller's business,
 * which keeps this function testable and the mail provider out of the auth
 * module. A null token means "no such account" and must not change what the
 * caller tells the user.
 */
export async function createPasswordReset(
  emailInput: unknown,
): Promise<{ token: string; email: string } | null> {
  if (!hasDatabase()) return null;
  const email = normaliseEmail(emailInput);
  if (!email) return null;

  let db: Db;
  try {
    db = await getDb();
  } catch {
    return null;
  }

  const userCollection = await users(db);
  const record = await userCollection.findOne({ email });
  if (!record) return null;

  const collection = await resets(db);
  // Only the newest link should work, so earlier ones are dropped.
  await collection.deleteMany({ userId: record.id });

  const { token, tokenHash } = createSessionToken();
  const now = new Date();
  await collection.insertOne({
    tokenHash,
    userId: record.id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + RESET_TTL_MS),
  });

  return { token, email: record.email };
}

export async function completePasswordReset(
  token: unknown,
  password: unknown,
): Promise<ActionOutcome | { ok: false; error: string; status: number }> {
  if (!hasDatabase()) {
    return { ok: false, error: 'Accounts need a configured database', status: 503 };
  }
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, error: 'That reset link is not valid', status: 400 };
  }
  if (typeof password !== 'string') {
    return { ok: false, error: 'A new password is required', status: 400 };
  }

  const problem = checkPasswordStrength(password);
  if (problem) {
    return {
      ok: false,
      error:
        problem === 'too-short'
          ? 'Use at least 10 characters'
          : problem === 'too-common'
            ? 'That password is too common'
            : problem === 'too-long'
              ? 'That password is too long'
              : 'Password cannot be blank',
      status: 400,
    };
  }

  let db: Db;
  try {
    db = await getDb();
  } catch (error) {
    return { ok: false, error: new DatabaseUnavailableError(error).hint, status: 503 };
  }

  const collection = await resets(db);
  const tokenHash = hashSessionToken(token);
  const reset = await collection.findOne({ tokenHash });
  if (!reset || reset.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'That reset link has expired', status: 400 };
  }

  const userCollection = await users(db);
  const record = await userCollection.findOne({ id: reset.userId });
  if (!record) {
    await collection.deleteOne({ tokenHash });
    return { ok: false, error: 'That reset link is not valid', status: 400 };
  }

  await userCollection.updateOne(
    { id: record.id },
    { $set: { passwordHash: await hashPassword(password) } },
  );
  // Single use, and every existing session goes: a reset is what someone does
  // when they believe another device has their account.
  await collection.deleteOne({ tokenHash });
  const sessionCollection = await sessions(db);
  await sessionCollection.deleteMany({ userId: record.id });

  return { ok: true };
}

export async function setTourDone(
  cookieHeader: string | null,
  done: boolean,
): Promise<ActionOutcome | { ok: false; error: string; status: number }> {
  return withAccount(cookieHeader, async (record, db) => {
    const collection = await users(db);
    await collection.updateOne(
      { id: record.id },
      done ? { $set: { tourDoneAt: new Date() } } : { $unset: { tourDoneAt: '' } },
    );
    return { ok: true as const };
  });
}



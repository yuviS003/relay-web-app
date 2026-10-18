/*
 * Browser-side encryption for environment secrets.
 *
 * API tokens are the most valuable thing this tool will ever hold, and the
 * database is the most likely thing to leak. Encrypting in the browser means
 * the server stores ciphertext it has no key for: a dump of the Mongo
 * collection yields nothing usable.
 *
 * What this does NOT protect: the proxy necessarily sees the decrypted token
 * while forwarding a request, because that is the whole job. The guarantee is
 * about the stored copy, not about transit, and the UI says so rather than
 * implying more.
 *
 * AES-GCM for authenticated encryption, so tampering is detected rather than
 * silently decrypting to garbage. PBKDF2 with a high iteration count because
 * the input is a human passphrase, which is low entropy and must be made
 * expensive to guess.
 */

const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function createSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

export async function deriveKey(
  passphrase: string,
  saltBase64: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(saltBase64) as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    // Not extractable: the key cannot be read back out of the browser, so a
    // later XSS cannot exfiltrate it even though it can use it.
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Returns `iv.ciphertext`, both base64. A fresh IV per value is required. */
export async function encryptSecret(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(
  key: CryptoKey,
  payload: string,
): Promise<string | null> {
  const [ivPart, cipherPart] = payload.split('.');
  if (!ivPart || !cipherPart) return null;

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(ivPart) as BufferSource },
      key,
      fromBase64(cipherPart) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // A wrong passphrase and a tampered ciphertext are indistinguishable
    // here, which is the correct behaviour: GCM authentication failed.
    return null;
  }
}

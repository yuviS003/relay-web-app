import { describe, expect, it } from 'vitest';

import {
  consumeRecoveryCode,
  createRecoveryCodes,
  hashRecoveryCode,
  isRecoveryCodeShaped,
  normaliseRecoveryCode,
} from '../src/lib/auth/recovery';
import {
  base32Decode,
  base32Encode,
  createTotpSecret,
  hotp,
  isTotpCodeShaped,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
  TOTP_STEP_SECONDS,
} from '../src/lib/auth/totp';

/*
 * The published vectors are the point of these tests. An authenticator app is
 * an independent implementation, so "our code agrees with itself" proves
 * nothing: agreement with RFC 4226 Appendix D and RFC 6238 Appendix B is what
 * says a phone will accept what we generate.
 */
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('matches the published encoding of the RFC test secret', () => {
    expect(base32Encode(Buffer.from(RFC_SECRET_ASCII))).toBe(RFC_SECRET_BASE32);
  });

  it('round-trips arbitrary bytes', () => {
    for (const length of [1, 2, 3, 5, 7, 10, 16, 20, 32]) {
      const bytes = Buffer.from(
        Array.from({ length }, (_, index) => (index * 37 + 11) % 256),
      );
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });

  it('ignores spacing, dashes, case and padding on input', () => {
    // How the secret is shown for manual entry, lowercased and padded by a
    // user copying it out of an authenticator app.
    const grouped = (base32Encode(Buffer.from(RFC_SECRET_ASCII)).match(/.{1,4}/g) ?? [])
      .join(' ')
      .toLowerCase();
    expect(base32Decode(`${grouped}=`).toString()).toBe(RFC_SECRET_ASCII);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base32Decode('ABC!')).toThrow(/base32/);
    expect(() => base32Decode('')).toThrow(/empty/);
    // 0, 1 and 8 are deliberately absent from RFC 4648 base32.
    expect(() => base32Decode('AAAA0')).toThrow(/base32/);
  });
});

describe('hotp', () => {
  // RFC 4226 Appendix D.
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it('matches the RFC 4226 counter vectors', () => {
    const secret = Buffer.from(RFC_SECRET_ASCII);
    expected.forEach((code, counter) => {
      expect(hotp(secret, counter)).toBe(code);
    });
  });
});

describe('totp', () => {
  // RFC 6238 Appendix B, SHA-1 rows, as 8 digits.
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  it('matches the RFC 6238 time vectors', () => {
    for (const [seconds, code] of vectors) {
      expect(totpCode(RFC_SECRET_BASE32, seconds * 1000, 8)).toBe(code);
    }
  });

  it('accepts the current code', () => {
    const secret = createTotpSecret();
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(verifyTotp(secret, totpCode(secret, now), { atMs: now })).toBe(
      totpStep(now),
    );
  });

  it('accepts one step of clock drift either way but not two', () => {
    const secret = createTotpSecret();
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const step = TOTP_STEP_SECONDS * 1000;

    for (const drift of [-1, 1]) {
      const code = totpCode(secret, now + drift * step);
      expect(verifyTotp(secret, code, { atMs: now })).toBe(totpStep(now) + drift);
    }
    for (const drift of [-2, 2]) {
      const code = totpCode(secret, now + drift * step);
      expect(verifyTotp(secret, code, { atMs: now })).toBeNull();
    }
  });

  it('refuses a code from a step already used, so it cannot be replayed', () => {
    const secret = createTotpSecret();
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const code = totpCode(secret, now);
    const step = verifyTotp(secret, code, { atMs: now });

    expect(step).toBe(totpStep(now));
    expect(verifyTotp(secret, code, { atMs: now, after: step ?? 0 })).toBeNull();
    // The next step's code is still accepted after that replay guard.
    const nextMs = now + TOTP_STEP_SECONDS * 1000;
    expect(
      verifyTotp(secret, totpCode(secret, nextMs), {
        atMs: nextMs,
        after: step ?? 0,
      }),
    ).toBe(totpStep(nextMs));
  });

  it('tolerates spacing but rejects anything that is not six digits', () => {
    const secret = createTotpSecret();
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const code = totpCode(secret, now);

    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { atMs: now })).toBe(
      totpStep(now),
    );
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34', null, 123456, {}]) {
      expect(verifyTotp(secret, bad, { atMs: now })).toBeNull();
    }
  });

  it('returns null for a malformed stored secret instead of throwing', () => {
    expect(verifyTotp('not base32!', '123456')).toBeNull();
  });

  it('shapes codes and builds a scannable otpauth URI', () => {
    expect(isTotpCodeShaped('123456')).toBe(true);
    expect(isTotpCodeShaped('12345')).toBe(false);
    expect(isTotpCodeShaped('abcdef')).toBe(false);

    const secret = createTotpSecret();
    const uri = new URL(otpauthUri('person@example.test', secret));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Relay:person@example.test');
    expect(uri.searchParams.get('secret')).toBe(secret);
    expect(uri.searchParams.get('issuer')).toBe('Relay');
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });

  it('generates a 160-bit secret', () => {
    const secret = createTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(createTotpSecret()).not.toBe(secret);
  });
});

describe('recovery codes', () => {
  it('issues formatted codes and stores only digests', () => {
    const { codes, hashes } = createRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) {
      expect(code).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
      expect(hashes).toContain(hashRecoveryCode(code));
      // The digest must not be reversible to the code by inspection.
      expect(hashes.join()).not.toContain(normaliseRecoveryCode(code));
    }
  });

  it('accepts a code however it was written down', () => {
    const { codes, hashes } = createRecoveryCodes();
    const [first] = codes;
    const remaining = consumeRecoveryCode(hashes, ` ${first!.toUpperCase()} `);
    expect(remaining).toHaveLength(7);
    expect(consumeRecoveryCode(hashes, first!.replace('-', ''))).toHaveLength(7);
  });

  it('spends a code once', () => {
    const { codes, hashes } = createRecoveryCodes();
    const [first, second] = codes;
    const remaining = consumeRecoveryCode(hashes, first!);
    expect(remaining).not.toBeNull();
    expect(consumeRecoveryCode(remaining!, first!)).toBeNull();
    expect(consumeRecoveryCode(remaining!, second!)).toHaveLength(6);
  });

  it('rejects codes that were never issued', () => {
    const { hashes } = createRecoveryCodes();
    for (const bad of ['', 'abc', 'zzzzz-zzzzz', null, 42, 'a'.repeat(10)]) {
      expect(consumeRecoveryCode(hashes, bad)).toBeNull();
    }
  });

  it('recognises the shape without needing the digests', () => {
    expect(isRecoveryCodeShaped('abcde-fghjk')).toBe(true);
    expect(isRecoveryCodeShaped('abcdefghjk')).toBe(true);
    expect(isRecoveryCodeShaped('abcde')).toBe(false);
  });
});

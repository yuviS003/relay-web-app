import { describe, expect, it } from 'vitest';

import { describeBlockedAddress, guardTarget } from '../src/lib/proxy/guard';

/*
 * These tests are the actual security boundary. Each case corresponds to a
 * real SSRF technique, so a regression here is a vulnerability, not a cosmetic
 * failure.
 */

describe('describeBlockedAddress', () => {
  it('blocks loopback, private, and link-local IPv4', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '0.0.0.0',
      '100.64.0.1',
    ]) {
      expect(describeBlockedAddress(address), address).not.toBeNull();
    }
  });

  it('blocks the cloud metadata address', () => {
    // The single highest-value SSRF target: it hands out instance credentials.
    expect(describeBlockedAddress('169.254.169.254')).toContain('link-local');
  });

  it('blocks multicast, reserved, and broadcast', () => {
    for (const address of ['224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255']) {
      expect(describeBlockedAddress(address), address).not.toBeNull();
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1']) {
      expect(describeBlockedAddress(address), address).toBeNull();
    }
  });

  it('treats 172.32.0.0 as public, just outside the private block', () => {
    // Off-by-one here would either leak the private range or break customers.
    expect(describeBlockedAddress('172.15.255.255')).toBeNull();
    expect(describeBlockedAddress('172.16.0.0')).not.toBeNull();
    expect(describeBlockedAddress('172.31.255.255')).not.toBeNull();
    expect(describeBlockedAddress('172.32.0.0')).toBeNull();
  });

  it('blocks IPv4-mapped IPv6 that wraps a private address', () => {
    // The classic bypass: loopback in an IPv6 costume.
    expect(describeBlockedAddress('::ffff:127.0.0.1')).toContain('loopback');
    expect(describeBlockedAddress('::ffff:169.254.169.254')).toContain('link-local');
    expect(describeBlockedAddress('::ffff:10.0.0.1')).toContain('private');
  });

  it('blocks IPv4-mapped IPv6 even when it wraps a public address', () => {
    /*
     * Deliberately stricter than necessary. `::ffff:8.8.8.8` is only 8.8.8.8
     * in an unusual costume, and allowing it would be defensible on
     * consistency grounds. It is refused anyway because no real API endpoint
     * is ever addressed this way, so in practice the notation shows up only
     * in bypass attempts — and permitting it would mean the unwrapping path
     * has to stay flawless forever to remain safe. Refusing the whole form
     * removes that standing obligation. A caller who genuinely wants that
     * host can send the plain IPv4 address.
     */
    expect(describeBlockedAddress('::ffff:8.8.8.8')).toBe('IPv4-mapped address');
    expect(describeBlockedAddress('::ffff:1.1.1.1')).toBe('IPv4-mapped address');
  });

  it('blocks IPv6 loopback, unspecified, ULA, link-local, and multicast', () => {
    expect(describeBlockedAddress('::1')).toContain('loopback');
    expect(describeBlockedAddress('::')).toContain('unspecified');
    expect(describeBlockedAddress('fc00::1')).toContain('unique local');
    expect(describeBlockedAddress('fd12:3456::1')).toContain('unique local');
    expect(describeBlockedAddress('fe80::1')).toContain('link-local');
    expect(describeBlockedAddress('ff02::1')).toContain('multicast');
  });

  it('allows ordinary public IPv6', () => {
    expect(describeBlockedAddress('2606:4700:4700::1111')).toBeNull();
    expect(describeBlockedAddress('2001:4860:4860::8888')).toBeNull();
  });

  it('rejects malformed input rather than defaulting to allowed', () => {
    for (const address of ['', 'nonsense', '1.2.3', '1.2.3.4.5', '999.1.1.1', 'fe80::g']) {
      expect(describeBlockedAddress(address), address).not.toBeNull();
    }
  });

  it('rejects zero-padded and non-decimal octets', () => {
    // Number() would happily read "0177.0.0.1" or "1e2.1.1.1"; a permissive
    // parser is itself the bypass.
    for (const address of ['0177.0.0.1', '1e2.1.1.1', '+1.1.1.1', '01.1.1.1']) {
      expect(describeBlockedAddress(address), address).not.toBeNull();
    }
  });
});

describe('guardTarget', () => {
  it('refuses a non-http scheme', async () => {
    // file: is how an SSRF becomes a local file read.
    const result = await guardTarget('file:///etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported-scheme');
  });

  it('refuses credentials embedded in the URL', async () => {
    const result = await guardTarget('https://user:secret@example.com/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('embedded-credentials');
  });

  it('refuses an unparseable URL', async () => {
    const result = await guardTarget('http://');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-url');
  });

  it('refuses an over-long URL before doing any work', async () => {
    const result = await guardTarget(`https://example.com/${'a'.repeat(3000)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('url-too-long');
  });

  it('refuses a literal loopback address without a lookup', async () => {
    const result = await guardTarget('http://127.0.0.1:8080/admin');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('blocked-address');
      expect(result.detail).toContain('loopback');
    }
  });

  it('refuses the metadata endpoint', async () => {
    const result = await guardTarget('http://169.254.169.254/latest/meta-data/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('link-local');
  });

  it('refuses bracketed IPv6 loopback', async () => {
    const result = await guardTarget('http://[::1]:3000/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('loopback');
  });

  it('refuses IPv4-mapped loopback in bracket form', async () => {
    const result = await guardTarget('http://[::ffff:127.0.0.1]/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('blocked-address');
  });

  it('pins a literal public address and defaults the port by scheme', async () => {
    const result = await guardTarget('https://1.1.1.1/dns-query');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address).toBe('1.1.1.1');
      expect(result.port).toBe(443);
      // The caller must connect to this address; handing the hostname to an
      // HTTP client instead would allow a second, hostile resolution.
      expect(result.hostname).toBe('1.1.1.1');
    }
  });

  it('keeps an explicit port', async () => {
    const result = await guardTarget('http://8.8.8.8:8443/x');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.port).toBe(8443);
  });

  it('reports an unresolvable host rather than throwing', async () => {
    const result = await guardTarget(
      'https://this-name-should-never-resolve.invalid/',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unresolvable-host');
  });
});

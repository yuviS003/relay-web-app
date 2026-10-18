import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activeMailProvider,
  mailerConfigured,
  parseSender,
  passwordResetMessage,
  sendMail,
} from '../src/lib/mail';

/*
 * The mailer is optional, which is exactly why it needs tests: the failure
 * everyone meets first is a provider key with no verified sending domain, and
 * the second is a MAIL_FROM that is a display name with no address. Both have
 * to end up as an honest "not configured" or a logged rejection rather than a
 * reset flow that silently drops the message.
 */

const KEYS = [
  'RESEND_API_KEY',
  'BREVO_API_KEY',
  'MAIL_FROM',
  'MAIL_PROVIDER',
] as const;

function configure(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => {
  configure({});
  vi.unstubAllGlobals();
});

describe('parseSender', () => {
  it('reads both the bare address and the display-name form', () => {
    expect(parseSender('relay@example.com')).toEqual({
      name: null,
      email: 'relay@example.com',
    });
    expect(parseSender('Relay <relay@example.com>')).toEqual({
      name: 'Relay',
      email: 'relay@example.com',
    });
    expect(parseSender('"Relay Support" <relay@example.com>')).toEqual({
      name: 'Relay Support',
      email: 'relay@example.com',
    });
  });

  it('refuses anything without a usable address', () => {
    // Each of these is a MAIL_FROM someone actually writes, and each would be
    // rejected by the provider after the reset had already been promised.
    for (const value of ['', '   ', 'Relay', 'Relay <relay>', 'relay@localhost']) {
      expect(parseSender(value), value).toBeNull();
    }
  });
});

describe('provider selection', () => {
  it('needs a key and a sender before it claims to be configured', () => {
    configure({});
    expect(mailerConfigured()).toBe(false);

    configure({ RESEND_API_KEY: 're_test' });
    expect(mailerConfigured()).toBe(false);

    configure({ RESEND_API_KEY: 're_test', MAIL_FROM: 'Relay' });
    expect(mailerConfigured()).toBe(false);

    configure({ RESEND_API_KEY: 're_test', MAIL_FROM: 'Relay <r@example.com>' });
    expect(mailerConfigured()).toBe(true);
  });

  it('picks either provider from its own key', () => {
    configure({ BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'r@example.com' });
    expect(activeMailProvider()?.id).toBe('brevo');

    configure({ RESEND_API_KEY: 're_test', MAIL_FROM: 'r@example.com' });
    expect(activeMailProvider()?.id).toBe('resend');
  });

  it('lets MAIL_PROVIDER break a tie, and refuses an unconfigured choice', () => {
    configure({
      RESEND_API_KEY: 're_test',
      BREVO_API_KEY: 'xkeysib-test',
      MAIL_FROM: 'r@example.com',
      MAIL_PROVIDER: 'brevo',
    });
    expect(activeMailProvider()?.id).toBe('brevo');

    // Named but keyless: better to report "not configured" than to quietly
    // send through the other provider the operator did not choose.
    configure({ RESEND_API_KEY: 're_test', MAIL_FROM: 'r@example.com', MAIL_PROVIDER: 'brevo' });
    expect(activeMailProvider()).toBeNull();
    expect(mailerConfigured()).toBe(false);
  });
});

describe('sendMail', () => {
  const message = passwordResetMessage('person@example.com', 'https://relay/?reset=t');

  it('reports a missing configuration instead of throwing', async () => {
    configure({});
    const result = await sendMail(message);
    expect(result).toMatchObject({ ok: false, reason: 'not-configured' });
    expect(result.ok === false && result.detail).toContain('RESEND_API_KEY');
  });

  it('shapes the Resend request the way Resend expects', async () => {
    configure({ RESEND_API_KEY: 're_test', MAIL_FROM: 'Relay <relay@example.com>' });
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response('{"id":"1"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await sendMail(message)).toEqual({ ok: true, provider: 'resend' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'Relay <relay@example.com>',
      to: ['person@example.com'],
      subject: 'Reset your Relay password',
      text: message.text,
    });
  });

  it('shapes the Brevo request the way Brevo expects', async () => {
    configure({ BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'Relay <relay@example.com>' });
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response('{"messageId":"1"}', { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await sendMail(message)).toEqual({ ok: true, provider: 'brevo' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init?.headers as Record<string, string>)['api-key']).toBe('xkeysib-test');
    // Sender split into fields, recipients as objects, body as textContent.
    expect(JSON.parse(String(init?.body))).toEqual({
      sender: { email: 'relay@example.com', name: 'Relay' },
      to: [{ email: 'person@example.com' }],
      subject: 'Reset your Relay password',
      textContent: message.text,
    });
  });

  it('keeps the provider status and body out of the caller, in the detail', async () => {
    configure({ RESEND_API_KEY: 're_test', MAIL_FROM: 'relay@example.com' });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          // What an unverified sending domain actually answers.
          new Response('{"message":"You can only send testing emails to your own address"}', {
            status: 403,
          }),
      ),
    );

    const result = await sendMail(message);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('rejected');
    expect(result.ok === false && result.detail).toContain('resend 403');
  });

  it('treats a provider that never answers as unreachable', async () => {
    configure({ RESEND_API_KEY: 're_test', MAIL_FROM: 'relay@example.com' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );

    expect(await sendMail(message)).toMatchObject({
      ok: false,
      reason: 'unreachable',
      detail: 'fetch failed',
    });
  });
});

describe('passwordResetMessage', () => {
  it('carries the link, the expiry and what to do if it was not you', () => {
    const built = passwordResetMessage('person@example.com', 'https://relay/?reset=abc');
    expect(built.to).toBe('person@example.com');
    expect(built.text).toContain('https://relay/?reset=abc');
    expect(built.text).toContain('30 minutes');
    expect(built.text).toContain('nothing has changed');
  });
});

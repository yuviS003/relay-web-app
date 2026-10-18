/*
 * Outgoing email, for the one flow that needs it: a password reset for someone
 * who cannot sign in.
 *
 * Deliberately absent unless configured. A reset flow that pretends to send
 * mail is worse than no reset flow: the user waits for a message that will
 * never arrive. So `mailerConfigured()` is part of the API, the endpoint
 * reports it, and the UI says so plainly.
 *
 * Two providers, because the free tiers that suit a project like this are
 * HTTP-first and interchangeable at this volume — one plain-text message per
 * reset. Both are reached with `fetch` against a fixed, operator-configured
 * endpoint, so neither needs the SSRF-guarded relay: that guard exists to stop
 * a *user-supplied* target reaching the private network, and these targets come
 * from the deployment's own environment.
 *
 * SMTP is deliberately not supported. It would mean a mail client dependency
 * and an outbound TCP connection from a serverless function, for one optional
 * flow that an HTTP API already covers.
 */

export type MailProviderId = 'resend' | 'brevo';

type MailProvider = {
  id: MailProviderId;
  /** The environment variable holding this provider's key. */
  keyVariable: string;
  endpoint: string;
  headers(key: string): Record<string, string>;
  body(message: MailMessage, from: Sender): unknown;
};

type Sender = { name: string | null; email: string };

/*
 * Order matters: with more than one key present and no MAIL_PROVIDER set, the
 * first configured provider here wins. Documented in .env.example so the
 * choice is never a surprise.
 */
const PROVIDERS: readonly MailProvider[] = [
  {
    id: 'resend',
    keyVariable: 'RESEND_API_KEY',
    endpoint: 'https://api.resend.com/emails',
    headers: (key) => ({
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    }),
    // Resend takes the RFC 5322 form directly, so the parsed name is rejoined.
    body: (message, from) => ({
      from: from.name ? `${from.name} <${from.email}>` : from.email,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  },
  {
    id: 'brevo',
    keyVariable: 'BREVO_API_KEY',
    endpoint: 'https://api.brevo.com/v3/smtp/email',
    headers: (key) => ({
      'api-key': key,
      accept: 'application/json',
      'content-type': 'application/json',
    }),
    body: (message, from) => ({
      sender: { email: from.email, ...(from.name ? { name: from.name } : {}) },
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
    }),
  },
];

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

function read(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `Name <address@example.com>` or a bare address.
 *
 * Parsed rather than passed through because the two providers disagree about
 * the shape: one wants the whole header, the other wants the address and the
 * display name as separate fields.
 */
export function parseSender(raw: string): Sender | null {
  const value = raw.trim();
  if (value === '') return null;

  const angled = /^(.*?)\s*<\s*([^<>\s]+)\s*>$/.exec(value);
  const email = (angled ? angled[2] : value)?.trim() ?? '';
  // Not full address validation — just enough to catch a MAIL_FROM that is a
  // display name with no address, which every provider would reject anyway.
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) return null;

  const name = angled?.[1]?.trim().replace(/^"|"$/g, '') ?? '';
  return { name: name === '' ? null : name, email };
}

/** The provider this deployment will use, if any is usable. */
export function activeMailProvider(): MailProvider | null {
  const wanted = read('MAIL_PROVIDER').toLowerCase();
  const configured = PROVIDERS.filter(
    (provider) => read(provider.keyVariable) !== '',
  );
  if (wanted !== '') {
    return configured.find((provider) => provider.id === wanted) ?? null;
  }
  return configured[0] ?? null;
}

export function mailerConfigured(): boolean {
  return activeMailProvider() !== null && parseSender(read('MAIL_FROM')) !== null;
}

export type MailResult =
  | { ok: true; provider: MailProviderId }
  | { ok: false; reason: 'not-configured' | 'rejected' | 'unreachable'; detail: string };

export async function sendMail(message: MailMessage): Promise<MailResult> {
  const provider = activeMailProvider();
  const from = parseSender(read('MAIL_FROM'));

  if (!provider || !from) {
    const keys = PROVIDERS.map((candidate) => candidate.keyVariable).join(' or ');
    return {
      ok: false,
      reason: 'not-configured',
      detail: !provider
        ? `Set ${keys} (and MAIL_PROVIDER when both are present) to enable email delivery`
        : 'Set MAIL_FROM to a sender address, optionally as "Name <address@example.com>"',
    };
  }

  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: provider.headers(read(provider.keyVariable)),
      body: JSON.stringify(provider.body(message, from)),
      // A hanging provider must not hang the request that triggered it.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        reason: 'rejected',
        /*
         * Truncated, and logged rather than returned to the caller. A provider
         * that has no verified domain answers 403 here — the usual first
         * failure, and the reason the README spells the requirement out.
         */
        detail: `${provider.id} ${response.status} ${detail.slice(0, 200)}`.trim(),
      };
    }
    return { ok: true, provider: provider.id };
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : 'Mail provider unreachable',
    };
  }
}

/** The reset message. Plain text, because this is a link and two sentences. */
export function passwordResetMessage(to: string, link: string): MailMessage {
  return {
    to,
    subject: 'Reset your Relay password',
    text: [
      'Someone asked to reset the password for this Relay account.',
      '',
      `Open this link within 30 minutes to choose a new one:`,
      link,
      '',
      'If that was not you, nothing has changed and you can ignore this message.',
      'The link can only be used once, and using it signs out every device.',
      '',
    ].join('\n'),
  };
}

/*
 * Suggestions for the header editor. Backs a native <datalist>, so the
 * browser supplies filtering, keyboard handling, and screen-reader support
 * that a hand-built dropdown would have to reimplement and usually gets wrong.
 *
 * Request headers only. Response-only headers would be noise at best and
 * misleading at worst.
 */

import type { BodyMode } from '@/lib/store/types';

export type HeaderSuggestion = {
  name: string;
  hint: string;
  values?: readonly string[];
};

export const COMMON_HEADERS: readonly HeaderSuggestion[] = [
  {
    name: 'accept',
    hint: 'Media types the client will take',
    values: [
      'application/json',
      'application/xml',
      'text/plain',
      'text/html',
      '*/*',
    ],
  },
  {
    name: 'accept-language',
    hint: 'Preferred languages',
    values: ['en', 'en-US,en;q=0.9'],
  },
  {
    name: 'authorization',
    hint: 'Credentials. Use {{a_secret}} rather than pasting a token',
    values: ['Bearer {{token}}', 'Basic {{basic_credentials}}'],
  },
  {
    name: 'cache-control',
    hint: 'Caching instructions',
    values: ['no-cache', 'no-store', 'max-age=0'],
  },
  {
    name: 'content-type',
    hint: 'Media type of the body you are sending',
    values: [
      'application/json',
      'application/x-www-form-urlencoded',
      'text/plain',
      'application/xml',
      'multipart/form-data',
    ],
  },
  {
    name: 'if-match',
    hint: 'Optimistic concurrency: act only if the entity tag still matches',
    values: ['{{etag}}'],
  },
  {
    name: 'if-none-match',
    hint: 'Conditional GET: 304 if unchanged',
    values: ['{{etag}}'],
  },
  {
    name: 'idempotency-key',
    hint: 'Makes a retried write safe to repeat',
    values: ['{{idempotency_key}}'],
  },
  {
    name: 'origin',
    hint: 'Origin of the request, for testing CORS behaviour',
  },
  {
    name: 'prefer',
    hint: 'Optional server behaviours',
    values: ['return=minimal', 'return=representation', 'respond-async'],
  },
  {
    name: 'range',
    hint: 'Request part of a resource',
    values: ['bytes=0-1023'],
  },
  {
    name: 'user-agent',
    hint: 'Identifies the client',
    values: ['web-api-client/0.1'],
  },
  {
    name: 'x-api-key',
    hint: 'Common non-standard API key header',
    values: ['{{api_key}}'],
  },
  {
    name: 'x-request-id',
    hint: 'Correlation id for tracing a call through services',
    values: ['{{request_id}}'],
  },
];

export const CONTENT_TYPE_PRESETS: readonly {
  id: BodyMode;
  label: string;
  contentType: string | null;
  sample: string;
}[] = [
  { id: 'none', label: 'None', contentType: null, sample: '' },
  {
    id: 'json',
    label: 'JSON',
    contentType: 'application/json',
    sample: '{\n  "key": "value"\n}',
  },
  {
    id: 'form',
    label: 'Form URL-encoded',
    contentType: 'application/x-www-form-urlencoded',
    sample: 'key=value&other=thing',
  },
  { id: 'text', label: 'Plain text', contentType: 'text/plain', sample: '' },
  {
    id: 'xml',
    label: 'XML',
    contentType: 'application/xml',
    sample: '<root>\n  <key>value</key>\n</root>',
  },
];

export function findHeader(name: string): HeaderSuggestion | undefined {
  const needle = name.trim().toLowerCase();
  return COMMON_HEADERS.find((header) => header.name === needle);
}

/*
 * Header names whose value is a credential.
 *
 * One definition, because two places need the same judgement and they must not
 * disagree: the AI assist redacts these before request details leave the
 * browser, and the sent-request view hides them until asked. A header that is
 * sensitive in one place is sensitive in the other.
 */
const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key|x-auth-token|x-amz-security-token)$/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER.test(name.trim());
}

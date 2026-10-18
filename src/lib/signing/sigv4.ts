import { createHash, createHmac } from 'node:crypto';

/*
 * AWS Signature Version 4.
 *
 * Implemented from the specification because it is a specification: a
 * canonical request, a string to sign, a derived key, one HMAC. The published
 * test suite is the proof, and the unit tests use it.
 *
 * Runs on the server, inside the relay, after {{variables}} are substituted.
 * Signing in the browser would sign a URL and body that the relay then
 * rewrites, producing a signature that cannot match — and it would also mean
 * shipping the secret access key into page scripts.
 */

export type SigV4Input = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  region: string;
  service: string;
  /** Overridable for the published vectors; defaults to now. */
  at?: Date | undefined;
};

const UNSIGNED_HEADERS = new Set([
  'authorization',
  'connection',
  'expect',
  'user-agent',
  'content-length',
  'x-amzn-trace-id',
]);

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

export function amzDate(at: Date): { stamp: string; date: string } {
  const stamp = `${at.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  return { stamp, date: stamp.slice(0, 8) };
}

/*
 * Each path segment is encoded, then the encoding of "/" is restored. S3 is
 * the documented exception: it signs the path as given, because its object
 * keys may contain characters that double-encoding would corrupt.
 */
function canonicalPath(url: URL, service: string): string {
  if (service === 's3') return url.pathname === '' ? '/' : url.pathname;
  const segments = (url.pathname === '' ? '/' : url.pathname)
    .split('/')
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)));
  return segments.join('/');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    pairs.push([encodeRfc3986(name), encodeRfc3986(value)]);
  }
  // Sorted by encoded name, then encoded value, as the specification requires.
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

export type SigV4Result = {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
};

export function signAwsV4(input: SigV4Input): SigV4Result {
  const url = new URL(input.url);
  const at = input.at ?? new Date();
  const { stamp, date } = amzDate(at);

  const payloadHash = sha256Hex(input.body ?? '');

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    headers[name.trim().toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  headers.host = url.host;
  headers['x-amz-date'] = stamp;
  headers['x-amz-content-sha256'] = payloadHash;
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;

  const signedNames = Object.keys(headers)
    .filter((name) => !UNSIGNED_HEADERS.has(name))
    .sort();

  const canonicalHeaders = signedNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url, input.service),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // The derived key chains date, region, service and a fixed terminator, so a
  // leaked signing key is useless outside that one day, region and service.
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, date);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, input.service);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8')
    .digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const applied: Record<string, string> = {
    authorization,
    'x-amz-date': stamp,
    'x-amz-content-sha256': payloadHash,
  };
  if (input.sessionToken) applied['x-amz-security-token'] = input.sessionToken;

  return { headers: applied, canonicalRequest, stringToSign, signature };
}

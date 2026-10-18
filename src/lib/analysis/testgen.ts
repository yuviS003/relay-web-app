/*
 * Generates post-response assertions from a response that actually arrived.
 *
 * The output is source for the same `test(name, fn)` / `expect(...)` DSL the
 * assertion sandbox runs, so a developer gets a working starting suite instead
 * of a blank editor. It asserts only what the response demonstrably showed:
 * its status, timing, content-type and — for JSON — validity and the shape of
 * its top level. Values are embedded with JSON.stringify so a body containing
 * quotes or newlines cannot break out of the generated string.
 */

export type GeneratableResponse = {
  status: number;
  statusText?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  durationMs?: number | undefined;
};

function lowerHeaders(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

/** A friendly token to assert the content-type contains. */
function contentTypeToken(contentType: string): string {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime.includes('json')) return 'json';
  if (mime.includes('html')) return 'html';
  if (mime.includes('xml')) return 'xml';
  return mime;
}

export function generateAssertions(response: GeneratableResponse): string {
  const headers = lowerHeaders(response.headers ?? {});
  const blocks: string[] = [];

  blocks.push(
    `test('status is ${response.status}', () => {\n  expect(response.status).toBe(${response.status});\n});`,
  );

  if (typeof response.durationMs === 'number' && response.durationMs >= 0) {
    // A generous ceiling (double the observed time, floor 1s, rounded up to
    // 100ms) so a passing request does not start failing on normal jitter.
    const bound = Math.max(1000, Math.ceil((response.durationMs * 2) / 100) * 100);
    blocks.push(
      `test('responds within ${bound}ms', () => {\n  expect(response.durationMs).toBeLessThan(${bound});\n});`,
    );
  }

  const contentType = headers['content-type'];
  if (contentType) {
    const token = contentTypeToken(contentType);
    blocks.push(
      `test('content-type is ${token}', () => {\n  expect(response.header('content-type')).toContain(${JSON.stringify(token)});\n});`,
    );
  }

  if (contentType?.includes('json') && typeof response.body === 'string') {
    try {
      const parsed: unknown = JSON.parse(response.body);
      blocks.push(`test('body is valid JSON', () => {\n  response.json();\n});`);

      if (Array.isArray(parsed)) {
        if (parsed.length > 0) {
          blocks.push(
            `test('body is a non-empty array', () => {\n  expect(response.json().length).toBeGreaterThan(0);\n});`,
          );
        }
      } else if (parsed !== null && typeof parsed === 'object') {
        // Cap the generated keys so a wide object does not emit a wall of
        // assertions; the developer can add the rest.
        for (const key of Object.keys(parsed).slice(0, 8)) {
          blocks.push(
            `test(${JSON.stringify(`body has "${key}"`)}, () => {\n  expect(response.json()).toHaveProperty(${JSON.stringify(key)});\n});`,
          );
        }
      }
    } catch {
      // Declared JSON but did not parse; the content-type assertion above
      // already captures the useful signal.
    }
  }

  return `${blocks.join('\n\n')}\n`;
}

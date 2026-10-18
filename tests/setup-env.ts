import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * Loads .env for the test run so the Mongo-backed suite can reach the real
 * cluster. Values already present in the environment win, which is what lets
 * CI inject a different cluster without editing a file.
 *
 * Deliberately hand-rolled rather than adding a dotenv dependency: this is the
 * whole feature.
 */
try {
  const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (key === '' || process.env[key] !== undefined) continue;

    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
} catch {
  // No .env is normal: the suites that need one skip themselves.
}

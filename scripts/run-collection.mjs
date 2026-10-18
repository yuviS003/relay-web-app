#!/usr/bin/env node
/*
 * Runs a saved collection against a running instance, for a pipeline.
 *
 * Imports the same runner the browser panel uses, compiled by
 * `npm run build:cli`, so a run here and a run in the app cannot disagree
 * about ordering, captures, or what counts as a failure. Everything still
 * travels through /api/relay: this is a client, not a second request path, so
 * the SSRF guard, the caps and the quota all apply exactly as they do in the UI.
 *
 * Usage:
 *   npm run collection -- --collection ./starter.json
 *   npm run collection -- --collection ./workspace.json --name Starter \
 *     --base https://relay.example --junit ./reports/relay.xml --bail
 *
 * Exits non-zero when any step fails, so a job fails with the suite.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const { runCollection } = await import('../.cli-build/lib/runner/run.js');
const { relayAttemptFromResponse } = await import(
  '../.cli-build/lib/runner/transport.js'
);
const { toJUnitXml, toTextReport } = await import('../.cli-build/lib/runner/junit.js');

function parseArgs(argv) {
  const options = {
    base: process.env.BASE_URL ?? 'http://localhost:3000',
    collection: null,
    name: null,
    env: null,
    junit: null,
    bail: false,
    delay: 0,
    cookie: process.env.RELAY_COOKIE ?? null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case '--base':
        options.base = value();
        break;
      case '--collection':
      case '-c':
        options.collection = value();
        break;
      case '--name':
        options.name = value();
        break;
      case '--env':
        options.env = value();
        break;
      case '--junit':
        options.junit = value();
        break;
      case '--delay':
        options.delay = Number(value());
        break;
      case '--cookie':
        options.cookie = value();
        break;
      case '--bail':
        options.bail = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option "${flag}"`);
    }
  }
  return options;
}

const HELP = `Run a saved collection through a running Relay instance.

  --collection, -c <file>  Collection or workspace export to run (required)
  --name <collection>      Which collection, when the file holds several
  --base <url>             Instance to run against (default http://localhost:3000)
  --env <file>             Environment JSON whose variables seed the run
  --junit <file>           Write a JUnit XML report here
  --delay <ms>             Wait between requests
  --bail                   Stop at the first failing step
  --cookie <value>         Session cookie, for collections that need an account
`;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error.message}`);
  }
}

/** Accepts a single collection, a workspace export, or an array of either. */
function selectCollection(document, name) {
  const candidates = Array.isArray(document)
    ? document
    : Array.isArray(document?.collections)
      ? document.collections
      : [document];

  const usable = candidates.filter(
    (entry) => entry && typeof entry === 'object' && Array.isArray(entry.requests),
  );
  if (usable.length === 0) {
    throw new Error('No collection with a requests array was found in that file');
  }
  if (!name) {
    if (usable.length > 1) {
      const names = usable.map((entry) => entry.name ?? entry.id).join(', ');
      throw new Error(`That file holds several collections; pass --name (${names})`);
    }
    return usable[0];
  }
  const wanted = usable.find(
    (entry) => entry.name === name || entry.id === name,
  );
  if (!wanted) throw new Error(`No collection named "${name}" in that file`);
  return wanted;
}

function seedVariables(collection, environmentDocument) {
  const values = {};
  for (const variable of collection.variables ?? []) {
    if (variable?.name) values[variable.name] = String(variable.value ?? '');
  }
  const environments = Array.isArray(environmentDocument?.environments)
    ? environmentDocument.environments
    : environmentDocument
      ? [environmentDocument]
      : [];
  for (const environment of environments) {
    for (const variable of environment?.variables ?? []) {
      if (!variable?.name) continue;
      if (variable.secret === true) {
        // Secrets are ciphertext until a passphrase decrypts them in a
        // browser, and this runner has no passphrase. Sending the ciphertext
        // would look like a working token and fail confusingly upstream.
        console.warn(
          `  ! skipping encrypted variable ${variable.name}: it can only be decrypted in the browser`,
        );
        continue;
      }
      values[variable.name] = String(variable.value ?? '');
    }
  }
  return values;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.collection) {
    console.log(HELP);
    process.exit(options.collection ? 0 : 1);
  }

  const collection = selectCollection(
    readJson(options.collection),
    options.name,
  );
  const variables = seedVariables(
    collection,
    options.env ? readJson(options.env) : null,
  );

  const endpoint = new URL('/api/relay', options.base).href;
  const send = async (payload) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: JSON.stringify(payload),
    });
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      // A non-JSON body is itself the failure; the mapper reports the status.
    }
    return relayAttemptFromResponse(response.status, parsed);
  };

  console.log(
    `Running ${collection.requests.length} request(s) from "${collection.name ?? collection.id}" against ${options.base}\n`,
  );

  const summary = await runCollection({
    collection: collection.name ?? collection.id ?? 'Collection',
    requests: collection.requests,
    variables,
    send,
    bail: options.bail,
    delayMs: Number.isFinite(options.delay) ? options.delay : 0,
    onStep: (step, index, total) => {
      const mark = step.status === 'passed' ? '✓' : step.status === 'skipped' ? '–' : '✗';
      const code = step.httpStatus === null ? '—' : step.httpStatus;
      console.log(
        `  ${mark} [${index + 1}/${total}] ${step.method} ${step.name} → ${code} (${step.durationMs}ms)`,
      );
      for (const failure of step.assertions.results.filter((result) => !result.ok)) {
        console.log(`      ✗ ${failure.name}: ${failure.detail ?? 'failed'}`);
      }
      for (const capture of step.captures.filter((entry) => !entry.ok)) {
        console.log(`      ! capture ${capture.name}: ${capture.detail}`);
      }
      if (step.error) console.log(`      ${step.error}`);
    },
  });

  console.log(`\n${toTextReport(summary)}`);

  if (options.junit) {
    const path = resolve(options.junit);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, toJUnitXml(summary), 'utf8');
    console.log(`\nJUnit report written to ${path}`);
  }

  process.exit(summary.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(2);
});

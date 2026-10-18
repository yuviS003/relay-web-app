import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

import { chromium } from 'playwright-core';
import { MongoClient } from 'mongodb';

/*
 * Browser-level application suite.
 *
 * Expects a running app: BASE_URL=http://localhost:3007 npm run test:e2e
 * It creates one temporary account, exercises real Atlas persistence and the
 * real relay, then removes everything belonging to that account in finally.
 * A failure therefore leaves no test data behind unless Atlas itself is down.
 */

function loadEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) continue;
      const separator = raw.indexOf('=');
      if (separator === -1) continue;
      const key = raw.slice(0, separator).trim();
      if (process.env[key] !== undefined) continue;
      let value = raw.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Local mode needs no env file.
  }
}

loadEnv();

const base = process.env.BASE_URL ?? 'http://localhost:3000';
const screenshotDir = process.env.SCREENSHOT_DIR;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const candidates = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const executablePath = candidates.find((candidate) => existsSync(candidate));
if (!executablePath) {
  throw new Error('No Chrome/Chromium found. Set CHROME_PATH to its executable.');
}

const email = `e2e-${Date.now()}@example.test`;
const password = 'e2e browser passphrase 4821';
const nextPassword = 'e2e rotated passphrase 9074';
let createdUser = false;
let browser;
let guestStepCount = 0;
let totpSecret = '';
let recoveryCodes = [];

const step = (label) => console.log(`  ✓ ${label}`);

/*
 * A second, deliberately independent TOTP implementation.
 *
 * The harness has to behave like the authenticator app, and generating codes
 * by importing the application's own module would only prove it agrees with
 * itself. This is written straight from RFC 6238 against node:crypto; the unit
 * suite checks both against the published vectors.
 *
 * `authenticatorCode` also tracks the steps it has spent, because the server
 * refuses a code from a step already used — the same code typed twice in one
 * 30-second window is a replay, not a valid sign-in.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let spentStep = -1;

function base32ToBytes(secret) {
  const clean = secret.replace(/[^A-Za-z2-7]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function codeForStep(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32ToBytes(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** A code the server will accept now, never reusing a spent step. */
function authenticatorCode(secret) {
  const now = Math.floor(Date.now() / 1000 / 30);
  const counter = now > spentStep ? now : spentStep + 1;
  spentStep = counter;
  return codeForStep(secret, counter);
}

/** Walks the guided tour to the end, or skips it, and asserts it closed. */
async function clearTour(page, { walk = false, expectSteps = 0 } = {}) {
  const card = page.locator('.tourCard');
  await card.waitFor({ timeout: 15_000 });
  const progress = await page.locator('.tourProgress').textContent();
  const total = Number(/of (\d+)/.exec(progress ?? '')?.[1] ?? 0);
  assert.ok(total >= 4, `tour should have several steps, read "${progress}"`);

  // The page behind must be inert, not merely dimmed: the spotlight shades it
  // with a shadow that does not catch clicks, so a separate blocker has to be
  // in front of the interface at every step.
  const covered = await page.evaluate(() => {
    const bar = document.querySelector('.topbar');
    if (!bar) return false;
    const rect = bar.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit?.closest('.tourRoot') !== null && hit !== null;
  });
  assert.ok(covered, 'the tour must cover the interface behind it');
  if (expectSteps) {
    assert.equal(total, expectSteps, 'tour step count for this audience');
  }

  if (walk) {
    for (let index = 1; index < total; index += 1) {
      await card.getByRole('button', { name: 'Next' }).click();
      assert.match(
        await page.locator('.tourProgress').textContent(),
        new RegExp(`Step ${index + 1} of ${total}`),
        'tour advances one step at a time',
      );
    }
    await card.getByRole('button', { name: 'Finish' }).click();
  } else {
    await card.getByRole('button', { name: 'Skip tour' }).click();
  }
  await card.waitFor({ state: 'detached', timeout: 10_000 });
  return total;
}
const shot = async (page, name) => {
  if (!screenshotDir) return;
  await page.screenshot({ path: `${screenshotDir}/${name}.png` });
};

/*
 * `locator.count()` and `locator.inputValue()` read the DOM once and do not
 * retry, unlike the locator actions above them. Immediately after a click that
 * triggers a React state update, the commit can land after the read, so an
 * assertion on the new DOM compares against the old one and fails even though
 * the application is correct.
 *
 * These helpers poll for the expected value first and assert afterwards. The
 * assertion is kept so a genuine mismatch still reports actual vs expected
 * rather than surfacing as an opaque wait timeout.
 */
const POLL_TIMEOUT = 10_000;

async function expectCount(page, selector, expected, label = selector) {
  await page
    .waitForFunction(
      ([target, want]) => document.querySelectorAll(target).length === want,
      [selector, expected],
      { timeout: POLL_TIMEOUT },
    )
    .catch(() => {});
  assert.equal(await page.locator(selector).count(), expected, label);
}

async function expectAtLeast(page, selector, minimum, label = selector) {
  await page
    .waitForFunction(
      ([target, want]) => document.querySelectorAll(target).length >= want,
      [selector, minimum],
      { timeout: POLL_TIMEOUT },
    )
    .catch(() => {});
  assert.ok(
    (await page.locator(selector).count()) >= minimum,
    `${label}: expected at least ${minimum}`,
  );
}

async function expectValue(page, selector, expected, label = selector) {
  await page
    .waitForFunction(
      ([target, want]) => document.querySelector(target)?.value === want,
      [selector, expected],
      { timeout: POLL_TIMEOUT },
    )
    .catch(() => {});
  assert.equal(await page.locator(selector).inputValue(), expected, label);
}

/** A dialog moves focus after it opens, so the first read can miss it. */
async function expectFocus(page, id, label = id) {
  await page
    .waitForFunction((want) => document.activeElement?.id === want, id, {
      timeout: POLL_TIMEOUT,
    })
    .catch(() => {});
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    id,
    label,
  );
}

/*
 * Measures dialog field geometry once the dialog has actually laid out.
 *
 * Reading straight after the click that opens it returned an empty list, which
 * made the alignment comparison `undefined === undefined` and pass without
 * measuring anything. Waiting for the fields and asserting the count keeps the
 * check from silently succeeding on a dialog that never opened.
 */
const DIALOG_FIELD = 'dialog:modal .dialogGrid > .dialogField';

async function readDialogFields(page, minimum = 2) {
  await page
    .waitForFunction(
      ([target, want]) => document.querySelectorAll(target).length >= want,
      [DIALOG_FIELD, minimum],
      { timeout: POLL_TIMEOUT },
    )
    .catch(() => {});
  const fields = await page.evaluate(
    (target) =>
      [...document.querySelectorAll(target)].map((field) => ({
        label: Math.round(
          field.querySelector('label')?.getBoundingClientRect().y ?? -1,
        ),
        control: Math.round(
          field
            .querySelector('input,select,textarea')
            ?.getBoundingClientRect().y ?? -1,
        ),
      })),
    DIALOG_FIELD,
  );
  assert.ok(
    fields.length >= minimum,
    `expected at least ${minimum} dialog fields, measured ${fields.length}`,
  );
  return fields;
}

/*
 * Every block stacked in a dialog body must sit the same distance from its
 * neighbour. The body used to space siblings by hand, so a field followed by a
 * grid row touched it while a field followed by a callout got a full gap, and
 * the modals read as unevenly spaced. Measuring real boxes catches that
 * whatever the markup of a future dialog looks like.
 */
async function assertEvenDialogRhythm(page, label) {
  const { blocks, gaps } = await page.evaluate(() => {
    const body = document.querySelector('dialog[open] .dialogBody');
    const kids = [...(body?.children ?? [])];
    return {
      blocks: kids.length,
      gaps: kids.slice(1).map((child, index) =>
        Math.round(
          child.getBoundingClientRect().top -
            kids[index].getBoundingClientRect().bottom,
        ),
      ),
    };
  });
  // One block is trivially even; zero means the dialog never opened.
  assert.ok(blocks >= 1, `${label}: dialog body has nothing to measure`);
  for (const gap of gaps) {
    assert.ok(gap > 0, `${label}: blocks touch, gaps ${gaps.join(', ')}`);
    assert.ok(
      Math.abs(gap - gaps[0]) <= 1,
      `${label}: uneven block spacing, gaps ${gaps.join(', ')}`,
    );
  }
}

/**
 * Fills a segmented one-time code input.
 *
 * Writes every digit into the first box: the component spreads a multi-digit
 * value across the rest, which is what autofill and paste both do. Also
 * asserts the digits landed, because a silent no-op here would show up much
 * later as "the wrong code was rejected".
 */
async function enterCode(scope, selector, code) {
  const first = scope.locator(selector);
  await first.fill(code);
  await scope
    .locator(`${selector} ~ input`)
    .last()
    .waitFor({ timeout: 5_000 })
    .catch(() => {});
  const filled = await scope.locator(`${selector}`).inputValue();
  assert.equal(filled, code.slice(0, 1), `first box holds the first digit of ${code}`);
}

/** The request names of one collection, in sidebar order. */
const readRequestOrder = (page, collection) =>
  page.evaluate((label) => {
    const list = document.querySelector(`ul[aria-label="${label} requests"]`);
    return [...(list?.querySelectorAll('button.reqOpen .truncate') ?? [])].map((node) =>
      (node.textContent ?? '').trim(),
    );
  }, collection);

async function expectOrder(page, collection, expected, label) {
  await page
    .waitForFunction(
      ([name, want]) => {
        const list = document.querySelector(`ul[aria-label="${name} requests"]`);
        const names = [
          ...(list?.querySelectorAll('button.reqOpen .truncate') ?? []),
        ].map((node) => (node.textContent ?? '').trim());
        return JSON.stringify(names) === want;
      },
      [collection, JSON.stringify(expected)],
      { timeout: POLL_TIMEOUT },
    )
    .catch(() => {});
  assert.deepEqual(await readRequestOrder(page, collection), expected, label);
}

/*
 * Nothing in the sidebar may be wider than the sidebar.
 *
 * A row whose name did not ellipsise made the pane scrollable sideways, which
 * pushed the method badges and section headings out of view and brought the
 * row overflow menus to the edge. overflow-x: clip hides that from scrollWidth
 * now, so the widths of the children are measured directly as well.
 */
async function assertSidebarFits(page) {
  const report = await page.evaluate(() => {
    const aside = document.querySelector('aside.pane');
    const style = getComputedStyle(aside);
    const inner =
      aside.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    const wide = [
      ...aside.querySelectorAll(
        '.reqItem, .collectionHeading, .reqList, .notice, .field, .hops li',
      ),
    ]
      .map((el) => ({
        el: el.className.toString().split(' ')[0] || el.tagName.toLowerCase(),
        width: Math.round(el.getBoundingClientRect().width),
      }))
      .filter((entry) => entry.width > Math.ceil(inner) + 1);
    return {
      inner: Math.round(inner),
      clientWidth: aside.clientWidth,
      scrollWidth: aside.scrollWidth,
      scrollLeft: aside.scrollLeft,
      wide,
    };
  });
  assert.deepEqual(
    report.wide,
    [],
    `sidebar content wider than its pane: ${JSON.stringify(report)}`,
  );
  assert.ok(
    report.scrollWidth <= report.clientWidth + 1 && report.scrollLeft === 0,
    `sidebar scrolls sideways: ${JSON.stringify(report)}`,
  );
}

/**
 * Drags one row onto another row's half, or onto a drop zone. Uses real mouse
 * input so the browser's own drag machinery runs, not synthetic DragEvents
 * that would bypass it.
 */
async function dragRow(page, source, target, where) {
  /*
   * Both ends are scrolled into view *before* either is measured. A taller
   * sidebar made this matter: scrolling the target into view moved the source
   * out from under the coordinates already taken for it, and the press then
   * grabbed whichever row had slid into that spot — a different request,
   * dragged successfully, which looks like a product bug rather than a stale
   * measurement.
   */
  await target.scrollIntoViewIfNeeded();
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const box = await target.boundingBox();
  assert.ok(from, 'drag source must be visible');
  assert.ok(box, 'drag target must be visible');
  /*
   * Both ends have to be on screen at once. Chromium decides what is being
   * dragged from the element under the pointer at the first move after the
   * press, so a target that still needs scrolling mid-drag slides a different
   * row under the pointer and that one travels instead — a wrong-row move that
   * reads like an application bug.
   */
  const viewport = page.viewportSize();
  for (const [label, rect] of [
    ['source', from],
    ['target', box],
  ]) {
    assert.ok(
      rect.y >= 0 && rect.y + rect.height <= (viewport?.height ?? Infinity),
      `drag ${label} is not fully on screen: ${JSON.stringify({ rect, viewport })}`,
    );
  }

  const targetPosition =
    where === 'below'
      ? { x: Math.round(box.width / 2), y: Math.round(box.height - 2) }
      : where === 'above'
        ? { x: Math.round(box.width / 2), y: 2 }
        : { x: Math.round(box.width / 2), y: Math.round(box.height / 2) };
  if (process.env.DEBUG_DRAG) {
    console.log(
      'DEBUG drag',
      JSON.stringify({
        from,
        box,
        underSource: await page.evaluate(
          ([x, y]) =>
            document
              .elementFromPoint(x, y)
              ?.closest('.reqItem')
              ?.textContent?.slice(0, 40) ?? null,
          [from.x + from.width / 2, from.y + from.height / 2],
        ),
        sourceText: (await source.textContent())?.slice(0, 40),
        targetText: (await target.textContent())?.slice(0, 40),
      }),
    );
  }
  await source.dragTo(target, { targetPosition });
}

/*
 * Accessibility, measured rather than asserted.
 *
 * axe-core is injected into the live page and run against the real DOM, so
 * this checks the application as assembled — colour contrast on the actual
 * theme, names on the actual buttons, roles on the actual tab lists. Only
 * serious and critical violations fail the run: axe's "moderate" findings
 * include advisory best practices that are judgement calls, and a gate that
 * fails on judgement calls gets switched off.
 */
const AXE_SOURCE = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');

async function assertAccessible(page, label, options = {}) {
  await page.evaluate(AXE_SOURCE);
  const report = await page.evaluate(async (include) => {
    const results = await window.axe.run(include ?? document, {
      resultTypes: ['violations'],
      // Rules about the document as a whole, which a single panel cannot fix.
      rules: { 'page-has-heading-one': { enabled: false }, region: { enabled: false } },
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.slice(0, 3).map((node) => ({
        target: node.target.join(' '),
        // The summary carries the measured ratio and the colours involved,
        // which is the difference between a fixable report and a puzzle.
        why: (node.failureSummary ?? '').split('\n').slice(1, 3).join(' '),
      })),
    }));
  }, options.include ?? null);

  const serious = report.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  assert.deepEqual(
    serious,
    [],
    `${label} has accessibility violations: ${JSON.stringify(serious, null, 2)}`,
  );
  return report;
}

async function cleanup() {
  if (!createdUser || !process.env.MONGODB_URI) return;
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15_000,
  });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB ?? 'web_api_client');
    const user = await db.collection('users').findOne({ email });
    if (!user) return;
    await Promise.all([
      db.collection('sessions').deleteMany({ userId: user.id }),
      db.collection('collections').deleteMany({ ownerId: user.id }),
      db.collection('environments').deleteMany({ ownerId: user.id }),
      db.collection('workspace_meta').deleteMany({ ownerId: user.id }),
      db.collection('users').deleteOne({ id: user.id }),
    ]);
  } finally {
    await client.close();
  }
}

try {
  const health = await fetch(`${base}/api/auth`);
  assert.equal(health.status, 200, `${base} is not a running Relay instance`);

  /*
   * Warm the document route before driving it. On a just-started server the
   * first navigation compiles and streams the page, and interacting during
   * that first hydration catches elements mid-replacement — a tab button was
   * reported "not stable", then detached. That is a cold-start artifact of the
   * harness, not application behaviour, so it is removed here rather than
   * papered over with sleeps inside the assertions.
   */
  await fetch(base, { headers: { accept: 'text/html' } }).then((response) =>
    response.text(),
  );

  browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();

  /*
   * No flow may fall back to a browser dialog. Recording them centrally, and
   * asserting none fired at the end, means a confirm() or alert() added
   * anywhere later fails the run instead of being auto-dismissed in silence.
   */
  const nativeDialogs = [];
  page.on('dialog', (dialog) => {
    nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss().catch(() => {});
  });

  /*
   * The sidebar updates optimistically, so the DOM shows a move before it is
   * written. Counting the workspace writes lets a reload wait for persistence
   * instead of racing it — and asserts a cross-collection move writes both
   * collections, not just the destination.
   */
  /*
   * Auth and account POSTs, with their status. Both endpoints are rate
   * limited, and a 429 there looks like a UI bug from the outside: a button
   * that appears to do nothing. Recording them makes that visible.
   */
  const authCalls = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (
      response.request().method() === 'POST' &&
      (path === '/api/auth' || path === '/api/account')
    ) {
      authCalls.push(`${path} ${response.status()}`);
    }
  });

  let workspaceWrites = 0;
  page.on('response', (response) => {
    if (
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/workspace'
    ) {
      workspaceWrites += 1;
    }
  });
  const writesSettled = async (expected, from) => {
    const deadline = Date.now() + POLL_TIMEOUT;
    while (workspaceWrites < from + expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      workspaceWrites >= from + expected,
      `expected ${expected} workspace write(s), saw ${workspaceWrites - from}`,
    );
  };

  await page.goto(base, { waitUntil: 'networkidle' });
  const session = await page.evaluate(async () =>
    fetch('/api/auth', { cache: 'no-store' }).then((response) => response.json()),
  );

  if (session.mode === 'accounts') {
    const guestRelay = await page.request.post(`${base}/api/relay`, {
      data: {
        url: 'https://api.ipify.org?format=json',
        method: 'GET',
        headers: {},
        body: '',
        script: '',
        tests: '',
        variables: {},
      },
    });
    assert.equal(guestRelay.status(), 200);
    assert.equal((await guestRelay.json()).ok, true);

    await page.getByRole('button', { name: /Continue as guest/ }).click();
    await page.locator('.collectionGroup').first().waitFor({ timeout: 30_000 });

    /*
     * A first-time visitor is toured before anything else. The guest list is
     * shorter than the account one: the environment and settings steps are
     * dropped because neither applies to a visitor without an account.
     */
    const guestSteps = await clearTour(page);
    guestStepCount = guestSteps;
    assert.match(
      await page.locator('.commandTrigger').textContent(),
      /Search requests/,
      'the workbench is usable once the tour closes',
    );
    step(`guest sees a ${guestSteps}-step tour and can skip it`);

    assert.match(await page.locator('.guestChip').textContent(), /not saved/);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.authOverlay').waitFor();

    /*
     * Dismiss belongs in the corner, after the theme and install controls. It
     * used to sit left of them, which read as one of the controls rather than
     * as the way out of the card.
     */
    const headerOrder = await page.evaluate(() => {
      const close = document.querySelector('.authOverlay [aria-label="Close sign in"]');
      const theme = document.querySelector('.authOverlay .themeToggle, .authOverlay [aria-label*="theme" i]');
      if (!close || !theme) return null;
      return {
        closeX: Math.round(close.getBoundingClientRect().left),
        themeX: Math.round(theme.getBoundingClientRect().left),
      };
    });
    assert.ok(headerOrder, 'the overlay has both a close and a theme control');
    assert.ok(
      headerOrder.closeX > headerOrder.themeX,
      `close must be right of the theme toggle, got ${JSON.stringify(headerOrder)}`,
    );
    step('guest can relay, is asked to sign in only when saving, and dismiss sits last');

    await page.locator('.authOverlay').getByRole('button', { name: 'Create account' }).click();
    await page.locator('.authOverlay').getByLabel('Email').fill(email);
    const passwordInput = page.locator('.authOverlay input#password');
    await passwordInput.fill(password);
    assert.equal(await passwordInput.getAttribute('type'), 'password');
    await page.locator('.authOverlay').getByRole('button', { name: 'Show password' }).click();
    assert.equal(await passwordInput.getAttribute('type'), 'text');
    await page.locator('.authOverlay').getByRole('button', { name: 'Hide password' }).click();
    assert.equal(await passwordInput.getAttribute('type'), 'password');
    await page.locator('.authOverlay')
      .getByRole('button', { name: 'Create account', exact: true })
      .last()
      .click();
    createdUser = true;
    await page.locator('.authOverlay').waitFor({ state: 'detached', timeout: 30000 });
    await page.locator('.userChip').waitFor({ timeout: 30000 });

    /*
     * A new account is toured again even though this browser already saw the
     * guest tour: "seen" is stored per account on the server, so the tour
     * follows the account rather than the device. Walked to the end here, so
     * Next, the step counter and Finish are all exercised.
     */
    const accountSteps = await clearTour(page, { walk: true });
    assert.ok(
      accountSteps > guestStepCount,
      `the account tour should cover more than the guest one (${accountSteps} vs ${guestStepCount})`,
    );
    step('a fresh account is toured again and the tour walks to the end');

    /* ----- optional second factor, offered right after signing up ----- */
    const mfaDialog = page.locator('dialog[open]');
    await mfaDialog.getByText('Add a second factor').waitFor({ timeout: 15_000 });
    assert.ok(
      await mfaDialog.getByRole('button', { name: /Not now/ }).isVisible(),
      'the offer must be skippable',
    );
    await mfaDialog.getByRole('button', { name: 'Set it up' }).click();

    await page.locator('.mfaQr svg').waitFor({ timeout: 15_000 });
    totpSecret = (await page.locator('.mfaSecret').textContent()).replace(/\s/g, '');
    assert.match(totpSecret, /^[A-Z2-7]{32}$/, 'a 160-bit base32 secret is shown');

    /*
     * The code field is six boxes. Filling the first with all six digits is
     * both the shortest path here and the one a password manager takes: the
     * component spreads a multi-digit value across the boxes from wherever it
     * lands. A complete code submits itself, so there is no button to press.
     */
    await enterCode(page, 'dialog[open] #mfa-code', '000000');
    await page.locator('dialog[open] .dialogError').waitFor({ timeout: 15_000 });

    await enterCode(page, 'dialog[open] #mfa-code', authenticatorCode(totpSecret));

    await page.locator('.recoveryCodes li').first().waitFor({ timeout: 15_000 });
    recoveryCodes = await page.locator('.recoveryCodes li').allTextContents();
    assert.equal(recoveryCodes.length, 8, 'eight recovery codes are issued');
    await page.locator('dialog[open] button[type="submit"]').click();
    await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 10_000 });
    await page.locator('.userShield').waitFor({ timeout: 15_000 });
    step('second factor enrolls only after a real code, and issues recovery codes');

    /* ----- the challenge is not a session ----- */
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.locator('.authForm').waitFor({ timeout: 20_000 });
    await page.locator('.authForm').getByLabel('Email').fill(email);
    await page.locator('.authForm input#password').fill(password);
    await page
      .locator('.authForm')
      .getByRole('button', { name: 'Sign in', exact: true })
      .last()
      .click();
    await page.locator('#factor-code').waitFor({ timeout: 20_000 });

    /*
     * The half-finished sign-in carries a cookie that names the account, so
     * this is the check that it is not a session: the caller must read as
     * anonymous, see only the guest preview rather than the account's own
     * collections, and be refused any write.
     */
    const halfway = await page.evaluate(async () => {
      const auth = await fetch('/api/auth', { cache: 'no-store' }).then((r) => r.json());
      const read = await fetch('/api/workspace', { cache: 'no-store' });
      const readBody = await read.json();
      const write = await fetch('/api/workspace', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'collection',
          value: { id: 'mfa-bypass', name: 'Bypass', requests: [] },
        }),
      });
      return {
        user: auth.user,
        readMode: readBody.mode,
        readOnly: readBody.readOnly,
        writeStatus: write.status,
      };
    });
    assert.equal(halfway.user, null, 'a pending challenge must not read as signed in');
    assert.equal(halfway.readMode, 'guest', 'it sees the guest preview, not the account');
    assert.equal(halfway.readOnly, true, 'the preview is read-only');
    assert.equal(halfway.writeStatus, 401, 'writes are refused until the factor is in');

    await enterCode(page, '#factor-code', '123456');
    await page.locator('.notice.bad').waitFor({ timeout: 15_000 });

    await enterCode(page, '#factor-code', authenticatorCode(totpSecret));
    await page.locator('.userChip').waitFor({ timeout: 30_000 });
    assert.equal(
      await page.locator('.tourCard').count(),
      0,
      'the tour does not return once it has been seen',
    );
    step('sign-in needs the password and then a valid code, and the tour stays closed');

    /* ----- recovery codes work, once ----- */
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.locator('.authForm').waitFor({ timeout: 20_000 });
    await page.locator('.authForm').getByLabel('Email').fill(email);
    await page.locator('.authForm input#password').fill(password);
    await page
      .locator('.authForm')
      .getByRole('button', { name: 'Sign in', exact: true })
      .last()
      .click();
    await page.locator('#factor-code').waitFor({ timeout: 20_000 });
    // A recovery code is not six digits, so it has its own field behind the
    // "lost your authenticator" switch.
    await page.getByRole('button', { name: /Use a recovery code/ }).click();
    await page.locator('#factor-code').fill(recoveryCodes[0]);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await page.locator('.userChip').waitFor({ timeout: 30_000 });
    step('a recovery code signs in when the authenticator is unavailable');

    /* ----- passkeys, against a virtual authenticator ----- */

    /*
     * Chromium can emulate an authenticator over CDP, which is the only way to
     * test WebAuthn without a physical key: the browser performs real
     * registration and assertion ceremonies against a software credential, so
     * the server's challenge handling, origin binding and signature
     * verification are all genuinely exercised.
     */
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    await page.getByRole('button', { name: 'Settings' }).click();
    /*
     * Waiting for the empty state, not just the heading: the dialog grows as
     * the account overview arrives, and clicking mid-reflow caught the button
     * being moved ("element is not stable").
     */
    await page
      .locator('.settingsDialog')
      .getByText('No passkeys registered.')
      .waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await page
      .locator('.settingsDialog')
      .getByText('Passkey registered. You can sign in with it next time.')
      .waitFor({ timeout: 30_000 });
    const credentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    assert.equal(credentials.credentials.length, 1, 'the authenticator holds one credential');
    await page.getByRole('button', { name: 'Close settings' }).click();

    // Now sign out and come back in with nothing but the passkey.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page
      .locator('.authForm')
      .waitFor({ timeout: 20_000 })
      .catch(async (problem) => {
        // Diagnostic, not decoration: this step has flaked twice and the
        // interesting state is gone by the time the failure is read.
        console.log('DEBUG auth calls:', authCalls.slice(-12).join(' | '));
        console.log(
          'DEBUG sign-out:',
          JSON.stringify(
            await page.evaluate(async () => ({
              dialogs: [...document.querySelectorAll('dialog')].map((node) => ({
                open: node.open,
                cls: node.className,
              })),
              hasAuthForm: Boolean(document.querySelector('.authForm')),
              hasWorkbench: Boolean(document.querySelector('.shell')),
              notice: document.querySelector('.notice')?.textContent ?? null,
              guestChip: document.querySelector('.guestChip')?.textContent ?? null,
              userChip: document.querySelector('.userChip')?.textContent ?? null,
              session: await fetch('/api/auth', { cache: 'no-store' })
                .then(async (response) => `${response.status} ${await response.text()}`)
                .catch((error) => String(error)),
            })),
          ),
        );
        throw problem;
      });
    await page.getByRole('button', { name: /Sign in with a passkey/ }).click();
    await page.locator('.userChip').waitFor({ timeout: 30_000 });
    assert.equal(
      await page.evaluate(async () =>
        fetch('/api/auth', { cache: 'no-store' })
          .then((response) => response.json())
          .then((session) => session.user?.email),
      ),
      email,
      'the passkey signed in the right account',
    );
    step('a passkey registers and then signs in with no password at all');

    /* ----- data export, and a reset request that cannot send mail ----- */

    const exported = await page.evaluate(async () => {
      const response = await fetch('/api/account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'export' }),
      });
      return response.json();
    });
    assert.ok(Array.isArray(exported.collections), 'the export carries collections');
    assert.ok(Array.isArray(exported.environments), 'the export carries environments');
    assert.equal(exported.account?.email, email);
    assert.ok(
      JSON.stringify(exported).includes('ciphertext'),
      'the export states that secret values are ciphertext',
    );
    assert.ok(
      !JSON.stringify(exported).includes('passwordHash'),
      'the export withholds password hashes',
    );

    const reset = await page.evaluate(async () => {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reset-request', email: 'nobody@example.test' }),
      });
      return response.json();
    });
    // Same answer for an address with no account, and an honest statement
    // about whether this deployment can send mail at all.
    assert.equal(reset.ok, true);
    assert.equal(typeof reset.mailerConfigured, 'boolean');
    assert.match(
      reset.message,
      reset.mailerConfigured ? /on its way/ : /not configured/,
      'the reset reply matches what the deployment can actually do',
    );
    step('account export withholds secrets, and a reset request answers honestly');

    /* ----- settings: profile, tour replay, password, turning MFA off ----- */
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.settingsDialog');
    await settings.getByText('Member since').waitFor({ timeout: 20_000 });
    assert.match(
      await settings.locator('.settingsFacts').textContent(),
      /Saved to your account/,
      'profile reports the workspace mode',
    );
    assert.match(
      await settings.locator('.methodChips').textContent(),
      /Password/,
      'profile lists the sign-in methods',
    );

    const security = settings.locator('[data-tour="settings-mfa"]');
    assert.equal(await security.locator('.badge').textContent(), 'On');
    assert.match(
      await security.locator('.settingsStatus').textContent(),
      /7 recovery codes left/,
      'the spent recovery code is gone',
    );

    // The tour is replayable from here.
    await settings.getByRole('button', { name: 'Start the tour' }).click();
    await clearTour(page);
    step('settings reports the account and replays the tour');

    await page.getByRole('button', { name: 'Settings' }).click();
    await settings.getByLabel('Current password').fill(password);
    await settings.getByLabel('New password', { exact: true }).fill(nextPassword);
    await settings.getByRole('button', { name: 'Change password' }).click();
    await settings.getByText(/Password updated/).waitFor({ timeout: 25_000 });

    await settings.getByLabel('Confirm with your password').fill(nextPassword);
    await settings.getByRole('button', { name: 'Turn off' }).click();
    await settings.getByText('Two-factor authentication is off.').waitFor({
      timeout: 25_000,
    });
    // The card switches back to its "off" shape only once the refreshed
    // account has come back, so wait for that rather than the note alone.
    await security
      .getByRole('button', { name: 'Turn on two-factor' })
      .waitFor({ timeout: 20_000 });
    assert.equal(await security.locator('.badge').textContent(), 'Off');
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await page.locator('.settingsDialog').waitFor({ state: 'hidden' });
    // The topbar follows the session, which reloads after the card does.
    await page
      .locator('.userShield')
      .waitFor({ state: 'detached', timeout: 20_000 });
    step('settings changes the password and turns the second factor back off');
  }

  await page.locator('.collectionGroup').first().waitFor({ timeout: 30_000 });

  /*
   * Any tour still open is cleared here.
   *
   * In accounts mode the guest and account tours were already walked above,
   * but with no database the suite never takes that path and the tour opens
   * for the local workspace instead — where it would block every click that
   * follows. Clearing it unconditionally keeps the rest of the run honest in
   * both modes.
   */
  await page
    .locator('.tourCard')
    .waitFor({ timeout: 3_000 })
    .then(() => page.getByRole('button', { name: /Skip tour|Close/ }).first().click())
    .catch(() => undefined);
  await page
    .locator('.tourCard')
    .waitFor({ state: 'detached', timeout: 5_000 })
    .catch(() => undefined);

  /*
   * The sample workspace, seeded once. Counted exactly rather than loosely,
   * because the bug this guards against is a second seeding run doubling
   * everything — which a "more than zero" check would sail past. The numbers
   * mirror SAMPLE_COLLECTIONS in src/lib/store/samples.ts.
   */
  assert.deepEqual(
    await page.locator('.collectionHeading strong').allTextContents(),
    [
      'Starter',
      'Chained run',
      'Auth helpers',
      'Cookies',
      'Viewers and history',
      'GraphQL and streaming',
    ],
    'seeded collections',
  );
  await expectCount(page, '.reqList button.reqOpen', 19, 'seeded requests');

  /*
   * Read back through the API rather than the sidebar, because what matters
   * here is what survived the round trip: auth blocks, captures and
   * collection variables all go through the store's validator on the way out
   * and back, and a sample that lost its auth block would still look right in
   * the sidebar. Checked without touching the open tabs, which the next
   * sections count.
   */
  const seeded = await page.evaluate(async () => {
    const response = await fetch('/api/workspace');
    return response.json();
  });
  const seededRequests = (seeded.collections ?? []).flatMap(
    (collection) => collection.requests ?? [],
  );
  assert.deepEqual(
    [
      ...new Set(
        seededRequests.map((request) => request.auth?.kind).filter(Boolean),
      ),
    ].sort(),
    ['basic', 'bearer', 'oauth2', 'sigv4'],
    'every auth helper is demonstrated by a seeded request',
  );
  assert.ok(
    seededRequests.some((request) => (request.captures ?? []).length > 0),
    'a seeded request captures a value for the next one',
  );
  assert.ok(
    (seeded.collections ?? []).some(
      (collection) => (collection.variables ?? []).length > 0,
    ),
    'a seeded collection carries its own variables',
  );
  step('new workspace seeded exactly once with six sample collections');

  // Save shortcut works even while an editor control has focus.
  await page.locator('.requestUrl').focus();
  await page.keyboard.press('Control+s');
  await page.locator('.responsePane').getByText('Public IP saved.', { exact: true }).waitFor();

  /*
   * Typing immediately after the shortcut, while the PUT is still in flight.
   * A save that wrote its own copy back over the editor on completion used to
   * revert these keystrokes, which is only visible when the round trip is slow.
   */
  const inFlightUrl = 'https://api.ipify.org?format=json&typed=during-save';
  await page.locator('.requestUrl').fill(inFlightUrl);
  await page.keyboard.press('Control+s');
  await page.locator('.requestUrl').fill(`${inFlightUrl}&again=1`);
  await page.waitForTimeout(1500);
  await expectValue(page, '.requestUrl', `${inFlightUrl}&again=1`, 'edits during save survive');
  await page.locator('.requestUrl').fill('https://api.ipify.org?format=json');
  step('Ctrl/Cmd+S saves while an input is focused and keeps in-flight edits');

  // Request tabs preserve edits independently while the user switches around.
  await expectCount(page, '.requestTab', 1, 'tabs on load');
  const originalUrl = await page.locator('.requestUrl').inputValue();
  const unsavedUrl = 'https://api.ipify.org?format=json&unsaved=yes';
  await page.locator('.requestUrl').fill(unsavedUrl);
  await page
    .getByRole('complementary')
    .getByRole('button', { name: /GET Blocked: cloud metadata/ })
    .click();
  await expectCount(page, '.requestTab', 2, 'tabs after opening a second');
  // The open-request strip is a list of buttons, not a tablist: each entry
  // carries its own close button, which a tablist may not own.
  await page
    .locator('.requestTabsScroller')
    .getByRole('button', { name: /GET Public IP/ })
    .click();
  await expectValue(page, '.requestUrl', unsavedUrl, 'unsaved url retained');
  await page.locator('.requestUrl').fill(originalUrl);
  await page.getByRole('button', { name: 'Close Blocked: cloud metadata' }).click();
  await expectCount(page, '.requestTab', 1, 'tabs after closing');
  step('request tabs preserve unsaved edits while switching and closing');

  /*
   * A response belongs to the tab that produced it, for as long as that tab is
   * open. It used to be a single slot: switching tabs and coming back showed an
   * empty pane for a request whose body had just arrived.
   */
  await page.getByRole('complementary').getByRole('button', { name: /GET Public IP/ }).click();
  await page.locator('.sendButton').click();
  await page.locator('.statusLine').waitFor({ timeout: 30_000 });
  const keptStatus = await page.locator('.statusLine').textContent();
  await page
    .getByRole('complementary')
    .getByRole('button', { name: /GET Scripted: timestamp/ })
    .click();
  assert.equal(
    await page.locator('.statusLine').count(),
    0,
    'a tab that has not been sent has no response of its own',
  );
  await page
    .locator('.requestTabsScroller')
    .getByRole('button', { name: /GET Public IP/ })
    .click();
  assert.equal(
    await page.locator('.statusLine').textContent(),
    keptStatus,
    'the response came back with its tab',
  );
  await page.getByRole('button', { name: 'Close Scripted: timestamp' }).click();
  step('a response stays with its request tab across switches');

  // Body format modes keep independent drafts and None sends no body.
  await page
    .getByRole('complementary')
    .getByRole('button', { name: /POST POST echo/ })
    .click();
  await page
    .getByRole('tablist', { name: 'Request detail' })
    .getByRole('tab', { name: /^Body/ })
    .click();
  const bodyEditor = page.locator('.bodyEditor');
  await page.locator('#body').fill('{"draft":"json"}');
  await bodyEditor.getByRole('button', { name: 'XML' }).click();
  await page.locator('#body').fill('<root><draft>xml</draft></root>');
  await bodyEditor.getByRole('button', { name: 'JSON' }).click();
  assert.equal(await page.locator('#body').inputValue(), '{"draft":"json"}');
  await bodyEditor.getByRole('button', { name: 'None' }).click();
  assert.equal(await page.locator('#body').count(), 0);
  await bodyEditor.getByRole('button', { name: 'XML' }).click();
  assert.equal(await page.locator('#body').inputValue(), '<root><draft>xml</draft></root>');
  await bodyEditor.getByRole('button', { name: 'Format' }).click();
  assert.match(await page.locator('#body').inputValue(), /\n  <draft>/);

  // Native edit shortcuts must keep working inside the controlled textarea.
  await bodyEditor.getByRole('button', { name: 'Plain text' }).click();
  const bodyInput = page.locator('#body');
  await bodyInput.fill('alpha');
  await bodyInput.press('End');
  await page.keyboard.type(' beta');
  await page.keyboard.press('Control+z');
  assert.equal(await bodyInput.inputValue(), 'alpha bet');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await bodyInput.inputValue(), 'alpha beta');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('End');
  await page.keyboard.press('Control+v');
  assert.equal(await bodyInput.inputValue(), 'alpha betaalpha beta');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+x');
  assert.equal(await bodyInput.inputValue(), '');
  await page.keyboard.press('Control+v');
  assert.equal(await bodyInput.inputValue(), 'alpha betaalpha beta');
  step('body modes preserve drafts, format content, and keep native edit shortcuts');

  // All multi-field dialogs must align on a common baseline.
  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Create request' })
    .click();
  const requestAlignment = await readDialogFields(page);
  assert.equal(requestAlignment[0]?.label, requestAlignment[1]?.label);
  assert.equal(requestAlignment[0]?.control, requestAlignment[1]?.control);
  await assertEvenDialogRhythm(page, 'new-request');
  await page.locator('dialog:modal').getByLabel('Name', { exact: true }).fill('Health check');
  await page
    .locator('dialog:modal')
    .getByLabel('URL', { exact: true })
    .fill('https://api.ipify.org?format=json');
  await page.locator('dialog:modal button[type="submit"]').click();
  await page
    .getByRole('complementary')
    .getByRole('button', { name: /GET Health check/ })
    .waitFor();

  const healthRow = page.locator('.reqItem', { hasText: 'Health check' });
  const actionSummary = healthRow.locator('summary');
  const actionBox = await actionSummary.boundingBox();
  assert.ok(actionBox && actionBox.width >= 28, 'request action menu is visible');
  await actionSummary.click();
  await healthRow.getByRole('button', { name: 'Rename' }).click();

  // Renaming is a dialog, not an inline input: it starts from the current name
  // and Escape leaves the request untouched.
  const renameDialog = page.locator('dialog:modal');
  await renameDialog.getByLabel('Name', { exact: true }).waitFor();
  assert.equal(
    await renameDialog.getByLabel('Name', { exact: true }).inputValue(),
    'Health check',
    'rename dialog prefills the current name',
  );
  await assertEvenDialogRhythm(page, 'rename-request');
  await renameDialog.getByLabel('Name', { exact: true }).fill('Health check renamed');
  await renameDialog.locator('button[type="submit"]').click();
  await page.locator('.reqList').getByText('Health check renamed', { exact: true }).waitFor();

  const renamedRow = page.locator('.reqItem', { hasText: 'Health check renamed' });
  await renamedRow.locator('summary').click();
  await renamedRow.getByRole('button', { name: 'Delete' }).click();

  // Deleting confirms in an app dialog. Cancelling must keep the request.
  const confirmDialog = page.locator('dialog:modal');
  await confirmDialog.getByText('Delete this request?').waitFor();
  assert.match(
    await confirmDialog.locator('.dialogPrompt').textContent(),
    /Health check renamed/,
    'confirmation names the request it will delete',
  );
  await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.reqList').getByText('Health check renamed', { exact: true }).waitFor();

  await renamedRow.locator('summary').click();
  await renamedRow.getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog:modal').getByRole('button', { name: 'Delete request' }).click();
  await page
    .locator('.reqList')
    .getByText('Health check renamed', { exact: true })
    .waitFor({ state: 'detached' });
  step('request menu renames and deletes through app dialogs, not browser ones');

  step('new-request modal is aligned and persists a request');

  /*
   * Sidebar order: drag and drop, the row menu, and persistence.
   *
   * A request row that refused to shrink used to make the whole sidebar
   * scrollable sideways, which hid the method badges and slid the overflow
   * menus into view, so the fitting check runs here too.
   */
  const starter = async () => readRequestOrder(page, 'Starter');
  const initialOrder = await starter();
  assert.ok(initialOrder.length >= 4, `expected the seeded requests, got ${initialOrder}`);
  await assertSidebarFits(page);

  const firstRow = page.locator('.reqItem', { hasText: initialOrder[0] });
  const lastRow = page.locator('.reqItem', { hasText: initialOrder.at(-1) });
  let writesBefore = workspaceWrites;
  await dragRow(page, firstRow, lastRow, 'below');
  const afterDrag = [...initialOrder.slice(1), initialOrder[0]];
  await expectOrder(page, 'Starter', afterDrag, 'drag moved the row to the end');
  await writesSettled(1, writesBefore);

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.collectionGroup').first().waitFor({ timeout: 30_000 });
  await expectOrder(page, 'Starter', afterDrag, 'the new order survived a reload');

  // The same move from the keyboard-reachable row menu.
  const movedRow = page.locator('.reqItem', { hasText: afterDrag.at(-1) });
  writesBefore = workspaceWrites;
  await movedRow.locator('summary').click();
  await movedRow.getByRole('button', { name: 'Move up' }).click();
  const afterNudge = [
    ...afterDrag.slice(0, -2),
    afterDrag.at(-1),
    afterDrag.at(-2),
  ];
  await expectOrder(page, 'Starter', afterNudge, 'row menu moved the request up');
  await writesSettled(1, writesBefore);

  // Across collections: create a second one and drop a request onto it.
  await page.getByRole('button', { name: 'New collection' }).click();
  await page.locator('dialog:modal').getByLabel('Collection name').fill('Archive');
  await page.locator('dialog:modal button[type="submit"]').click();
  await page
    .locator('.collectionHeading', { hasText: 'Archive' })
    .waitFor({ timeout: 20_000 });

  const mover = afterNudge[0];
  writesBefore = workspaceWrites;
  // Creating the collection put the focus at the bottom of a sidebar that now
  // holds the sample workspace; start the drag from a known scroll position.
  await page
    .locator('[data-tour="sidebar"]')
    .evaluate((pane) => {
      pane.scrollTop = 0;
    });
  await dragRow(
    page,
    page.locator('.reqItem', { hasText: mover }),
    page.locator('.collectionGroup', { hasText: 'Archive' }).locator('.reqEmpty'),
    'onto',
  );
  await expectOrder(page, 'Archive', [mover], 'request moved into the new collection');
  await expectOrder(
    page,
    'Starter',
    afterNudge.slice(1),
    'request left its old collection',
  );
  // Destination and source: a move that writes only one of them would leave a
  // duplicate behind after a reload.
  await writesSettled(2, writesBefore);

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.collectionGroup').first().waitFor({ timeout: 30_000 });
  await expectOrder(page, 'Archive', [mover], 'the move was persisted');
  await expectOrder(
    page,
    'Starter',
    afterNudge.slice(1),
    'the request is not left in both collections',
  );
  await assertSidebarFits(page);
  step('sidebar reorders and moves requests between collections, and stays inside its pane');

  await page.getByRole('button', { name: 'New environment' }).click();
  await assertEvenDialogRhythm(page, 'new-environment');
  await page.locator('dialog:modal').getByLabel('Environment name').fill('E2E');
  await page.locator('dialog:modal button[type="submit"]').click();
  await page.getByRole('option', { name: 'E2E' }).waitFor({ state: 'attached' });

  await page.getByRole('button', { name: 'Add encrypted secret' }).click();
  const secretAlignment = await readDialogFields(page);
  assert.equal(secretAlignment[0]?.control, secretAlignment[1]?.control);
  await assertEvenDialogRhythm(page, 'new-secret');
  await page.locator('dialog:modal').getByLabel('Variable name').fill('API_TOKEN');
  await page
    .locator('dialog:modal')
    .getByLabel('Passphrase')
    .fill('e2e secret passphrase');
  await page
    .locator('dialog:modal')
    .getByLabel('Secret value')
    .fill('not-a-real-token');
  await page.locator('dialog:modal button[type="submit"]').click();
  await page.locator('.hops li').filter({ hasText: 'API_TOKEN' }).waitFor();
  step('secret modal is aligned and stores ciphertext through Atlas');

  // cURL import: modal focus and parsed values.
  await page.getByRole('button', { name: 'Import cURL' }).click();
  await expectFocus(page, 'curl-command', 'cURL dialog focus');
  await assertEvenDialogRhythm(page, 'import-curl');
  await page
    .locator('dialog:modal')
    .getByLabel('cURL command')
    .fill("curl -X POST 'https://postman-echo.com/post' -H 'content-type: application/json' -d '{\"e2e\":true}'");
  await page.locator('dialog:modal button[type="submit"]').click();
  await expectValue(
    page,
    '.requestUrl',
    'https://postman-echo.com/post',
    'imported url',
  );
  await expectValue(page, '.methodSelect', 'POST', 'imported method');
  step('cURL import parses method, URL, headers and body in a real modal');

  // Successful relay over pinned HTTPS.
  await page.getByRole('complementary').getByRole('button', { name: /GET Public IP/ }).click();
  await page.locator('.sendButton').click();
  await page.locator('.statusLine').waitFor({ timeout: 30_000 });
  assert.match(await page.locator('.statusLine strong').textContent(), /^200/);
  step('public HTTPS request completes through the pinned relay');

  /*
   * The network indicator grades the connection from sends that happened, and
   * splits the time between the target and this app. It exists because a
   * four-second response reads as a slow client when almost all of it was the
   * network.
   */
  const netChip = page.locator('.netChip');
  await netChip.locator('summary').waitFor({ timeout: 10_000 });
  assert.match(
    await netChip.locator('.netLabel').textContent(),
    /Network · \d/,
    'the chip reports a measured figure after a send',
  );
  assert.equal(
    await netChip.locator('.netDot--unknown').count(),
    0,
    'the chip is no longer unmeasured',
  );
  await netChip.locator('summary').click();
  const netFacts = await netChip.locator('.netFacts').textContent();
  for (const label of ['To the target', 'Inside Relay', 'Measured over']) {
    assert.ok(netFacts.includes(label), `the breakdown lists "${label}"`);
  }
  await netChip.locator('summary').click();
  /*
   * One rhythm down the response pane. The notice, the status line and the
   * copy row each carried their own margin, so the gap above the status line
   * and the gap below it were visibly different.
   */
  const responseGaps = await page.evaluate(() => {
    const pane = document.querySelector('.responsePane');
    const blocks = [...(pane?.children ?? [])].filter((node) => {
      const box = node.getBoundingClientRect();
      return box.height > 0 && !node.classList.contains('paneHead');
    });
    return blocks.slice(1).map((node, index) =>
      Math.round(
        node.getBoundingClientRect().top -
          blocks[index].getBoundingClientRect().bottom,
      ),
    );
  });
  for (const gap of responseGaps) {
    assert.ok(
      Math.abs(gap - responseGaps[0]) <= 1,
      `uneven response spacing: ${responseGaps.join(', ')}`,
    );
  }
  step('network indicator grades the connection, and the response pane keeps one rhythm');

  // SSRF refusal before opening a socket.
  await page.getByRole('complementary').getByRole('button', { name: /GET Blocked: cloud metadata/ }).click();
  await page.locator('.sendButton').click();
  await page.locator('.codeErr').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('.codeErr').textContent(), 'blocked');
  assert.match(await page.locator('.notice.bad').textContent(), /link-local/);
  step('cloud metadata target is blocked before connection');

  // Bounded repeated hits with a real target.
  await page.getByRole('complementary').getByRole('button', { name: /GET Public IP/ }).click();
  await page.getByRole('tab', { name: 'Traffic' }).click();
  await page.getByRole('spinbutton', { name: 'Requests' }).fill('3');
  await page.getByRole('spinbutton', { name: 'Concurrency' }).fill('1');
  await page.getByRole('spinbutton', { name: 'Delay (ms)' }).fill('50');
  await page
    .getByText('I own this target or have explicit authorization to test it.')
    .click();
  await page.getByRole('button', { name: 'Run traffic test' }).click();
  await page.locator('.metricGrid').waitFor({ timeout: 45_000 });
  await expectCount(page, '.latencyBar', 3, 'latency bars');
  await shot(page, 'traffic-lab');
  step('traffic lab runs repeated hits and renders latency summary');

  // Non-destructive security checks plus a single CORS OPTIONS probe.
  await page.getByRole('tab', { name: 'Security' }).click();
  await page
    .getByText('I own this target or have explicit authorization to audit it.')
    .click();
  await page.getByRole('button', { name: 'Run security audit' }).click();
  await page.locator('.findingList').waitFor({ timeout: 45_000 });
  await expectAtLeast(page, '.findingList li', 3, 'audit findings');
  await shot(page, 'security-audit');
  step('security audit returns passive and CORS findings');

  // Response analysis: SEO judgement and extraction run client-side on the
  // body an HTML request returned through the relay.
  await page.locator('.requestUrl').fill('https://example.com');
  await page.locator('.sendButton').click();
  await page.locator('.statusLine').waitFor({ timeout: 30_000 });
  const responseTabs = page.getByRole('tablist', { name: 'Response detail' });

  await responseTabs.getByRole('tab', { name: 'SEO' }).click();
  await page.locator('.analysis .scoreRing strong').waitFor({ timeout: 10_000 });
  const seoScore = Number(
    await page.locator('.analysis .scoreRing strong').textContent(),
  );
  assert.ok(
    Number.isFinite(seoScore) && seoScore >= 0 && seoScore <= 100,
    `SEO score should be 0-100, got ${seoScore}`,
  );
  await expectAtLeast(page, '.analysis .findingList li', 5, 'SEO checks');

  await responseTabs.getByRole('tab', { name: 'Extract' }).click();
  await page.locator('.analysis .extractControls').waitFor({ timeout: 10_000 });
  // Assert on Metadata rather than links: a page's link count depends on the
  // live target (example.com currently ships no anchors), but any HTML page
  // has at least a <title>, so metadata extraction is a stable check.
  await page.locator('.analysis').getByRole('button', { name: 'Metadata' }).click();
  await expectAtLeast(page, '.analysis .kvList li', 1, 'extracted metadata');
  await shot(page, 'response-analysis');
  step('SEO judgement and extraction run on a fetched HTML response');

  // One-click combined report: security + SEO + extraction in a single pass.
  await page
    .getByRole('tablist', { name: 'Request detail' })
    .getByRole('tab', { name: 'Report' })
    .click();
  await page
    .getByText(/own this target or have explicit authorization to test/i)
    .click();
  await page.getByRole('button', { name: 'Run full report' }).click();
  await page.locator('.testLab .findingList').first().waitFor({ timeout: 45_000 });
  await expectAtLeast(page, '.testLab .reportSection', 2, 'report sections');
  await expectAtLeast(page, '.testLab .metricGrid .metric', 4, 'report overview tiles');
  await shot(page, 'full-report');
  step('one-click report combines security, SEO and extraction');

  // Dark default, optional light, and no overflow at desktop/mobile.
  assert.equal(
    await page.evaluate(() => document.documentElement.getAttribute('data-theme')),
    'dark',
  );
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  assert.equal(
    await page.evaluate(() => document.documentElement.getAttribute('data-theme')),
    'light',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    false,
  );
  step('theme switch and mobile layout have no horizontal overflow');

  const icon = await page.request.get(`${base}/icon.svg`);
  assert.equal(icon.status(), 200);
  assert.match(icon.headers()['content-type'] ?? '', /image\/svg\+xml/);

  const manifestResponse = await page.request.get(`${base}/manifest.webmanifest`);
  assert.equal(manifestResponse.status(), 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((entry) => entry.sizes === '192x192'));
  assert.ok(manifest.icons.some((entry) => entry.sizes === '512x512'));
  assert.equal((await page.request.get(`${base}/sw.js`)).status(), 200);
  step('PWA manifest, icons, service worker and favicon are served');

  assert.deepEqual(
    nativeDialogs,
    [],
    `the app opened browser dialogs: ${nativeDialogs.join(' | ')}`,
  );
  step('no browser alert, confirm or prompt was used anywhere in the run');

  /* ---------------- the new surfaces ---------------- */

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.collectionGroup').first().waitFor({ timeout: 30_000 });

  // Response history recorded the sends from earlier in this run, and two of
  // them can be compared.
  await page.getByRole('complementary').getByRole('button', { name: /GET Public IP/ }).click();
  await page.locator('.sendButton').click();
  await page.locator('.statusLine').waitFor({ timeout: 30_000 });
  await page.locator('.sendButton').click();
  await page.locator('.statusLine').waitFor({ timeout: 30_000 });

  const laterTabs = page.getByRole('tablist', { name: 'Response detail' });
  await laterTabs.getByRole('tab', { name: /^History/ }).click();
  await expectAtLeast(page, '.historyList li', 2, 'recorded responses');
  const picks = page.locator('.historyPick');
  await picks.nth(0).click();
  await picks.nth(1).click();
  await page.locator('.diffView').waitFor({ timeout: 10_000 });
  assert.match(
    await page.locator('.diffView').textContent(),
    /status|duration/,
    'the diff reports what changed between two runs',
  );
  step('history records responses and diffs two runs of the same request');

  // The JSON tree, its path filter, and a hexdump of the same body.
  await laterTabs.getByRole('tab', { name: 'Body' }).click();
  await page.locator('.jsonTree').waitFor({ timeout: 10_000 });
  await expectAtLeast(page, '.jsonRow', 2, 'tree rows');
  await page.getByLabel('Filter').fill('$.ip');
  await page.locator('.kvList li').first().waitFor();
  assert.match(
    await page.locator('.kvList li').first().textContent(),
    /\$\.ip/,
    'the filter reports the matched path',
  );
  /*
   * Raw is readable by default and can go back to the exact bytes. An API that
   * answers on one line is the normal case, so "raw" meaning "unformatted"
   * made the view useless for anything but copying.
   */
  await page.getByRole('tab', { name: 'Raw' }).click();
  const formatted = await page.locator('.bodyRaw').textContent();
  assert.match(formatted, /\n/, 'the raw view indents a one-line payload');
  await page.getByRole('button', { name: 'No whitespace' }).click();
  const minified = await page.locator('.bodyRaw').textContent();
  assert.doesNotMatch(minified, /\n/, 'no-whitespace strips the indentation');
  assert.ok(
    minified.length < formatted.length,
    `minified should be shorter: ${minified.length} vs ${formatted.length}`,
  );
  await page.getByRole('button', { name: 'Exactly as received' }).click();

  await page.getByRole('tab', { name: 'Hex' }).click();
  assert.match(await page.locator('.bodyHex').textContent(), /^00000000 {2}/, 'hexdump');
  step('body viewer shows a tree, a path filter, raw formatting and a hexdump');

  // Auth is applied server-side: the echo endpoint shows what was sent.
  await page.getByRole('tab', { name: /^Auth/ }).click();
  await page.getByLabel('Scheme').selectOption('bearer');
  // By id, not by label: sample requests with "token" in their name give the
  // sidebar row menus accessible names that a label lookup also matches.
  await page.locator('#auth-token').fill('{{probe_token}}');
  await page.locator('.requestUrl').fill('https://postman-echo.com/get');
  await page.getByRole('tab', { name: /^Pre-run/ }).click();
  await page.locator('#script').fill("vars.probe_token = 'from-a-script';\n");
  await page.locator('.sendButton').click();
  await page.locator('.statusLine').waitFor({ timeout: 30_000 });
  await laterTabs.getByRole('tab', { name: 'Body' }).click();
  await page.getByRole('tab', { name: 'Raw' }).click();
  assert.match(
    await page.locator('.bodyRaw').textContent(),
    /Bearer from-a-script/,
    'the bearer token was resolved from a script variable and applied by the relay',
  );
  step('request auth is applied after substitution, by the server');

  /*
   * What went out, as opposed to what was typed. The editor holds
   * {{probe_token}} and no Authorization header at all; the relay resolved one
   * from a script variable and added the other, and this view is the only
   * place either is visible. Credential values stay hidden until asked for.
   */
  // The sent view sits with the request, not the response: it describes what
  // was composed on the left, after resolution.
  await page.locator('[data-tour="tab-sent"]').click();
  await page.locator('.sentRequest').waitFor({ timeout: 10_000 });
  const sentHeaders = page.locator('.sentHeaders');
  assert.match(
    await sentHeaders.textContent(),
    /authorization/,
    'the sent view lists the header the server added',
  );
  assert.doesNotMatch(
    await sentHeaders.textContent(),
    /from-a-script/,
    'a credential value is not on screen until it is asked for',
  );
  await page.getByRole('button', { name: /Show \d+ credential value/ }).click();
  assert.match(
    await sentHeaders.textContent(),
    /Bearer from-a-script/,
    'revealing shows the real value the relay sent',
  );
  step('the sent view reports the resolved request, with credentials hidden by default');

  /*
   * Generated code has to be runnable where it is pasted, which means real
   * values: a snippet containing {{base_url}} is useful nowhere. The script
   * variable is the exception the UI calls out — nothing outside a send can
   * compute it — and "exact last send" is how it gets in.
   */
  await page.getByRole('tab', { name: /^Code/ }).click();
  const snippet = page.locator('.requestPane pre').first();
  await snippet.waitFor({ timeout: 10_000 });
  assert.match(
    await snippet.textContent(),
    /curl -X GET 'https:\/\/postman-echo\.com\/get'/,
    'the snippet carries the real URL',
  );
  await page.getByRole('checkbox', { name: /Exact last send/ }).check();
  assert.match(
    await snippet.textContent(),
    /Bearer from-a-script/,
    'the exact-send snippet carries the headers the relay really sent',
  );
  await page.getByRole('combobox', { name: 'Code target' }).selectOption('go');
  assert.match(
    await snippet.textContent(),
    /http\.NewRequest\("GET", "https:\/\/postman-echo\.com\/get"/,
    'another target generates from the same request',
  );
  await page.getByRole('checkbox', { name: /Exact last send/ }).uncheck();
  await page.getByRole('combobox', { name: 'Code target' }).selectOption('curl');

  /*
   * The two option labels must each be one line. As flex items they were being
   * squeezed, and "Exact last send" rendered as three stacked words beside its
   * checkbox.
   */
  const optionLines = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.codeOptions label')];
    return labels.map((label) => {
      const box = label.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight) || 16;
      return {
        text: (label.textContent ?? '').trim().slice(0, 24),
        lines: Math.round(box.height / lineHeight),
        top: Math.round(box.top),
      };
    });
  });
  assert.ok(optionLines.length >= 2, 'both code options are present');
  for (const label of optionLines) {
    assert.ok(label.lines <= 1, `"${label.text}" wrapped onto ${label.lines} lines`);
  }
  assert.equal(
    new Set(optionLines.map((label) => label.top)).size,
    1,
    `the options share a row: ${JSON.stringify(optionLines)}`,
  );
  step('generated code resolves variables, reproduces the exact last send, and its options fit one line');

  // A cookie the response set is held in the jar and offered back to that host.
  await page.locator('.requestUrl').fill('https://postman-echo.com/cookies/set?relay=e2e');
  await page.locator('.sendButton').click();
  await page.locator('.statusLine').waitFor({ timeout: 30_000 });
  await page.getByRole('tab', { name: /^Cookies/ }).click();
  // Scoped to the panel: the settings dialog lists passkeys with the same
  // class, and a closed dialog's rows are present but hidden.
  await page.locator('.cookiePanel .cookieList li').first().waitFor({ timeout: 10_000 });
  assert.match(
    await page.locator('.cookieOutgoing').textContent(),
    /relay=e2e/,
    'the jar offers the cookie back to the host that set it',
  );
  step('cookie jar stores Set-Cookie and scopes it to the host that sent it');

  // Importing an OpenAPI document creates a collection.
  await page.getByRole('button', { name: 'Import API' }).click();
  await page.locator('dialog:modal').getByLabel('Or paste it').fill(
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'E2E import' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/widgets/{id}': { get: { operationId: 'getWidget' } },
        '/widgets': {
          post: {
            operationId: 'createWidget',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    }),
  );
  await page.locator('.importList li').first().waitFor({ timeout: 10_000 });
  await page.locator('dialog:modal').getByRole('button', { name: /Import 2 requests/ }).click();
  await page
    .locator('.collectionHeading', { hasText: 'E2E import' })
    .waitFor({ timeout: 20_000 });
  await expectOrder(
    page,
    'E2E import',
    ['getWidget', 'createWidget'],
    'both operations were imported in order',
  );
  const imported = page.locator('.reqList button.reqOpen', { hasText: 'getWidget' });
  await imported.click();
  await expectValue(
    page,
    '.requestUrl',
    'https://api.example.com/widgets/{{id}}',
    'the path template became a variable',
  );
  step('OpenAPI import creates a collection with variables for path templates');

  // The streaming relay forwards chunks and keeps the guard.
  const streamed = await page.evaluate(async () => {
    const response = await fetch('/api/relay/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://postman-echo.com/stream/3', method: 'GET' }),
    });
    const text = await response.text();
    return {
      contentType: response.headers.get('content-type'),
      chunks: (text.match(/event: chunk/g) ?? []).length,
      done: text.includes('event: done'),
    };
  });
  assert.match(streamed.contentType ?? '', /text\/event-stream/);
  assert.ok(streamed.chunks >= 1, `expected streamed chunks, saw ${streamed.chunks}`);
  assert.ok(streamed.done, 'the stream reported its outcome');

  const blockedStream = await page.evaluate(async () => {
    const response = await fetch('/api/relay/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });
    return response.text();
  });
  assert.match(blockedStream, /"reason":"blocked"/, 'the guard still applies when streaming');
  // And the panel that consumes it, driven from the UI.
  await page.locator('.requestUrl').fill('https://postman-echo.com/stream/3');
  await page.getByRole('tab', { name: /^Stream/ }).click();
  await page.getByRole('button', { name: 'Start streaming' }).click();
  await page.locator('.streamFrames li').first().waitFor({ timeout: 60_000 });
  await page.locator('.streamPanel .settingsStatus').waitFor({ timeout: 60_000 });
  assert.match(
    await page.locator('.streamPanel .settingsStatus').textContent(),
    /\d+ bytes/,
    'the stream panel reports the bytes it received',
  );
  step('streaming relay forwards chunks, refuses a blocked target, and feeds the panel');

  // Accessibility of the assembled application, and of a dialog.
  await assertAccessible(page, 'the workbench');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('.settingsDialog').waitFor();
  await assertAccessible(page, 'settings', { include: '.settingsDialog' });
  await page.getByRole('button', { name: 'Close settings' }).click();
  step('axe-core finds no serious accessibility violations in the app or a dialog');

  /*
   * The GraphQL editor writes the request body, which is what gets sent, so
   * this is checkable without a GraphQL server: type a document and variables,
   * and the body must become the payload a server expects.
   */
  await page.getByRole('tab', { name: /^GraphQL/ }).click();
  await page.getByLabel('Document').fill('query Me($id: ID!) { node(id: $id) { id } }');
  await page.getByLabel('Variables (JSON)').fill('{"id":"7"}');
  await page.getByLabel('Operation name (optional)').fill('Me');
  await page.getByRole('tab', { name: /^Body/ }).click();
  const graphqlBody = JSON.parse(await page.locator('#body').inputValue());
  assert.deepEqual(
    graphqlBody,
    {
      query: 'query Me($id: ID!) { node(id: $id) { id } }',
      variables: { id: '7' },
      operationName: 'Me',
    },
    'the GraphQL editor writes the payload a server expects',
  );
  await expectValue(page, '.methodSelect', 'POST', 'GraphQL switches the method');
  await page.getByRole('tab', { name: /^GraphQL/ }).click();
  await page.getByLabel('Variables (JSON)').fill('{not json');
  await page.locator('.notice.bad').waitFor({ timeout: 10_000 });
  step('GraphQL mode builds the request payload and reports invalid variables');

  /*
   * The collection runner, from the sidebar. The expected step count is read
   * from the sidebar first: earlier checks moved a request to another
   * collection, so hard-coding the starter's original four would be asserting
   * against a collection this run has already changed.
   */
  const starterNow = await readRequestOrder(page, 'Starter');
  assert.ok(starterNow.length >= 2, `expected a populated Starter, got ${starterNow}`);
  await page.getByRole('button', { name: 'Run Starter' }).click();
  await page.locator('.runnerDialog').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Run collection' }).click();
  await page
    .locator('.runnerDialog')
    .getByText(/steps ·/)
    .waitFor({ timeout: 120_000 });
  await expectCount(page, '.runnerStep', starterNow.length, 'one step per request');
  assert.match(
    await page.locator('.runnerDialog .settingsStatus').last().textContent(),
    /assertions passed/,
    'the run reports its assertion totals',
  );
  await page.getByRole('button', { name: 'Close runner' }).click();
  step('collection runner runs every request in order and reports each outcome');

  console.log('\nApplication E2E passed.');
} finally {
  await browser?.close().catch(() => undefined);
  await cleanup();
}

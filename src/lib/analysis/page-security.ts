/*
 * Page-body security hygiene, as a complement to the header-based audit in
 * `lib/testing/security.ts`. Both are strictly passive: they read what the
 * target already returned and never send a payload, guess a path, or attempt
 * an exploit. The intent is to flag an attack surface a reviewer should look
 * at, not to attack anything.
 *
 * This runs on the parsed document, so it catches issues the raw headers
 * cannot show: mixed content, reverse-tabnabbing, forms that would submit
 * credentials over plain HTTP, the third-party script surface, and inline
 * handlers that a Content Security Policy would have to accommodate.
 */

import type { SecurityFinding } from '@/lib/testing/security';

import { absoluteUrl, type ResponseContext } from './html';

export function auditPageBody(
  doc: Document,
  ctx: ResponseContext,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const isHttps = ctx.finalUrl.startsWith('https://');

  // --- Mixed content: http sub-resources on an https page ---
  if (isHttps) {
    const resourceAttrs: Array<[string, string]> = [
      ['script[src]', 'src'],
      ['link[href]', 'href'],
      ['img[src]', 'src'],
      ['iframe[src]', 'src'],
    ];
    const mixed = new Set<string>();
    for (const [selector, attr] of resourceAttrs) {
      for (const el of Array.from(doc.querySelectorAll(selector))) {
        const raw = el.getAttribute(attr) ?? '';
        if (/^http:\/\//i.test(raw.trim())) mixed.add(raw.trim());
      }
    }
    if (mixed.size > 0) {
      findings.push({
        id: 'mixed-content',
        title: 'Mixed content on an HTTPS page',
        severity: 'high',
        detail: `${mixed.size} resource(s) load over plain HTTP, which browsers block or downgrade trust for. Example: ${[...mixed][0]}`,
      });
    } else {
      findings.push({
        id: 'mixed-content',
        title: 'No mixed content',
        severity: 'pass',
        detail: 'All sub-resources use HTTPS or relative URLs.',
      });
    }
  }

  // --- Reverse tabnabbing: target=_blank without rel=noopener ---
  const risky = Array.from(doc.querySelectorAll('a[target="_blank"]')).filter(
    (a) => {
      const rel = (a.getAttribute('rel') ?? '').toLowerCase();
      return !rel.includes('noopener') && !rel.includes('noreferrer');
    },
  );
  if (risky.length > 0) {
    findings.push({
      id: 'tabnabbing',
      title: 'Links open new tabs without rel=noopener',
      severity: 'low',
      detail: `${risky.length} link(s) use target="_blank" without rel="noopener"; the opened page can script window.opener. Modern browsers imply noopener, but older ones do not.`,
    });
  }

  // --- Credentials over HTTP: a password field in a form posting to http ---
  const passwordForms = Array.from(
    doc.querySelectorAll('form'),
  ).filter((form) => form.querySelector('input[type="password"]'));
  for (const form of passwordForms) {
    const action = absoluteUrl(form.getAttribute('action'), ctx.finalUrl) ?? ctx.finalUrl;
    if (action.startsWith('http://')) {
      findings.push({
        id: 'password-plaintext',
        title: 'Password field submits over HTTP',
        severity: 'high',
        detail: `A form containing a password input targets ${action}, so the password would travel unencrypted.`,
      });
      break;
    }
  }

  // --- Third-party script surface ---
  const scriptOrigins = new Set<string>();
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const resolved = absoluteUrl(script.getAttribute('src'), ctx.finalUrl);
    if (!resolved) continue;
    try {
      const host = new URL(resolved).host;
      if (host !== new URL(ctx.finalUrl).host) scriptOrigins.add(host);
    } catch {
      // Unparseable src is ignored; it loads nothing.
    }
  }
  if (scriptOrigins.size > 0) {
    findings.push({
      id: 'third-party-scripts',
      title: 'Third-party scripts present',
      severity: 'info',
      detail: `Scripts load from ${scriptOrigins.size} external origin(s): ${[...scriptOrigins].slice(0, 5).join(', ')}${scriptOrigins.size > 5 ? '…' : ''}. Each is part of the page's trust and supply-chain surface.`,
    });

    // External scripts without Subresource Integrity run whatever the origin
    // serves at request time, so a compromised CDN executes in this page.
    const unpinned = Array.from(doc.querySelectorAll('script[src]')).filter(
      (script) => {
        const resolved = absoluteUrl(script.getAttribute('src'), ctx.finalUrl);
        if (!resolved) return false;
        try {
          const external = new URL(resolved).host !== new URL(ctx.finalUrl).host;
          return external && !script.getAttribute('integrity');
        } catch {
          return false;
        }
      },
    );
    if (unpinned.length > 0) {
      findings.push({
        id: 'sri-missing',
        title: 'External scripts without Subresource Integrity',
        severity: 'low',
        detail: `${unpinned.length} cross-origin script(s) have no integrity attribute, so a compromised or swapped file would execute unchecked.`,
      });
    }
  }

  // --- Inline event handlers (CSP friction / injection surface) ---
  let inlineHandlers = 0;
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on[a-z]+$/i.test(attr.name)) inlineHandlers += 1;
    }
  }
  if (inlineHandlers > 0) {
    findings.push({
      id: 'inline-handlers',
      title: 'Inline event handlers in markup',
      severity: 'low',
      detail: `${inlineHandlers} inline handler attribute(s) (onclick and similar). These require 'unsafe-inline' in a script CSP, which weakens it.`,
    });
  }

  // --- Meta refresh redirects ---
  const metaRefresh = doc.querySelector('meta[http-equiv="refresh" i]');
  if (metaRefresh) {
    findings.push({
      id: 'meta-refresh',
      title: 'Client-side meta refresh',
      severity: 'low',
      detail: `A <meta http-equiv="refresh"> is present ("${metaRefresh.getAttribute('content') ?? ''}"). Prefer a server redirect; meta refresh is fragile and can be used for cloaking.`,
    });
  }

  return findings;
}

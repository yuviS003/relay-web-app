export type SecuritySeverity = 'pass' | 'info' | 'low' | 'medium' | 'high';

export type SecurityFinding = {
  id: string;
  title: string;
  severity: SecuritySeverity;
  detail: string;
};

export type AuditedResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
};

function headers(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

/**
 * Passive security posture from one response. It never sends an exploit and
 * never guesses paths; it analyses information the target already returned.
 */
export function auditResponse(response: AuditedResponse): SecurityFinding[] {
  const h = headers(response.headers);
  const findings: SecurityFinding[] = [];
  const https = response.url.startsWith('https://');
  const contentType = h['content-type'] ?? '';
  const isHtml = contentType.includes('text/html');

  findings.push(
    h['x-content-type-options']?.toLowerCase() === 'nosniff'
      ? {
          id: 'nosniff',
          title: 'MIME sniffing disabled',
          severity: 'pass',
          detail: 'X-Content-Type-Options is nosniff.',
        }
      : {
          id: 'nosniff',
          title: 'MIME sniffing is not disabled',
          severity: 'medium',
          detail: 'Add X-Content-Type-Options: nosniff.',
        },
  );

  if (https) {
    const hsts = h['strict-transport-security'];
    findings.push(
      hsts
        ? {
            id: 'hsts',
            title: 'HTTPS downgrade protection present',
            severity: 'pass',
            detail: `Strict-Transport-Security: ${hsts}`,
          }
        : {
            id: 'hsts',
            title: 'HSTS is missing',
            severity: 'medium',
            detail: 'HTTPS is in use, but the response does not instruct browsers to stay on it.',
          },
    );

    if (hsts) {
      // A short max-age or a header scoped to one host leaves gaps a downgrade
      // attack can use before the policy takes hold.
      const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? '0');
      const sixMonths = 15_552_000;
      if (maxAge < sixMonths) {
        findings.push({
          id: 'hsts-depth',
          title: 'HSTS max-age is short',
          severity: 'low',
          detail: `max-age is ${maxAge}s; a value below ~6 months (${sixMonths}s) narrows the protection window.`,
        });
      } else if (!/includesubdomains/i.test(hsts)) {
        findings.push({
          id: 'hsts-depth',
          title: 'HSTS does not cover subdomains',
          severity: 'low',
          detail: 'max-age is adequate, but includeSubDomains is absent, so subdomains are unprotected.',
        });
      }
    }
  }

  if (isHtml) {
    const csp = h['content-security-policy'];
    const frameProtected =
      Boolean(csp?.toLowerCase().includes('frame-ancestors')) ||
      Boolean(h['x-frame-options']);

    findings.push(
      csp
        ? {
            id: 'csp',
            title: 'Content Security Policy present',
            severity: 'pass',
            detail: csp,
          }
        : {
            id: 'csp',
            title: 'Content Security Policy missing',
            severity: 'medium',
            detail: 'HTML can load scripts and resources without a response-level CSP boundary.',
          },
    );

    if (csp) {
      const lower = csp.toLowerCase();
      const weaknesses: string[] = [];
      if (lower.includes("'unsafe-inline'")) weaknesses.push("'unsafe-inline'");
      if (lower.includes("'unsafe-eval'")) weaknesses.push("'unsafe-eval'");
      if (weaknesses.length > 0) {
        findings.push({
          id: 'csp-quality',
          title: 'CSP weakened by unsafe directives',
          severity: 'medium',
          detail: `The policy allows ${weaknesses.join(' and ')}, which largely reopens the XSS vector a CSP is meant to close.`,
        });
      }
    }

    findings.push(
      frameProtected
        ? {
            id: 'frame',
            title: 'Framing is restricted',
            severity: 'pass',
            detail: csp?.includes('frame-ancestors')
              ? 'CSP frame-ancestors is present.'
              : `X-Frame-Options: ${h['x-frame-options']}`,
          }
        : {
            id: 'frame',
            title: 'Page can be framed',
            severity: 'medium',
            detail: 'No CSP frame-ancestors or X-Frame-Options was returned.',
          },
    );
  }

  findings.push(
    h['referrer-policy']
      ? {
          id: 'referrer',
          title: 'Referrer policy explicit',
          severity: 'pass',
          detail: `Referrer-Policy: ${h['referrer-policy']}`,
        }
      : {
          id: 'referrer',
          title: 'Referrer policy not explicit',
          severity: 'low',
          detail: 'Add a Referrer-Policy appropriate to the application.',
        },
  );

  findings.push(
    h['permissions-policy']
      ? {
          id: 'permissions-policy',
          title: 'Permissions policy present',
          severity: 'pass',
          detail: `Permissions-Policy: ${h['permissions-policy']}`,
        }
      : {
          id: 'permissions-policy',
          title: 'No permissions policy',
          severity: 'low',
          detail: 'Powerful features (camera, geolocation, etc.) are not restricted by a Permissions-Policy header.',
        },
  );

  // Cross-origin isolation headers. Absent is common and not itself a flaw, so
  // these are informational unless a strong COOP is already in place.
  if (isHtml) {
    findings.push(
      h['cross-origin-opener-policy']
        ? {
            id: 'coop',
            title: 'Cross-Origin-Opener-Policy set',
            severity: 'pass',
            detail: `Cross-Origin-Opener-Policy: ${h['cross-origin-opener-policy']}`,
          }
        : {
            id: 'coop',
            title: 'No Cross-Origin-Opener-Policy',
            severity: 'info',
            detail: 'Without COOP, a cross-origin opener keeps a window reference to this document.',
          },
    );
  }

  if (h.server || h['x-powered-by']) {
    findings.push({
      id: 'server-disclosure',
      title: 'Server implementation disclosed',
      severity: 'low',
      detail: [h.server ? `server=${h.server}` : '', h['x-powered-by'] ? `x-powered-by=${h['x-powered-by']}` : '']
        .filter(Boolean)
        .join(', '),
    });
  } else {
    findings.push({
      id: 'server-disclosure',
      title: 'No obvious server banner',
      severity: 'pass',
      detail: 'Server and X-Powered-By headers are absent.',
    });
  }

  const setCookie = h['set-cookie'];
  if (setCookie) {
    const lower = setCookie.toLowerCase();
    if (!lower.includes('httponly')) {
      findings.push({
        id: 'cookie-http-only',
        title: 'Cookie readable by JavaScript',
        severity: 'high',
        detail: 'A Set-Cookie value is missing HttpOnly.',
      });
    }
    if (https && !lower.includes('secure')) {
      findings.push({
        id: 'cookie-secure',
        title: 'Cookie may travel over HTTP',
        severity: 'high',
        detail: 'An HTTPS response set a cookie without Secure.',
      });
    }
    if (!lower.includes('samesite')) {
      findings.push({
        id: 'cookie-samesite',
        title: 'Cookie has no SameSite policy',
        severity: 'medium',
        detail: 'Set SameSite=Lax or Strict unless cross-site use is deliberate.',
      });
    } else if (lower.includes('samesite=none') && !lower.includes('secure')) {
      findings.push({
        id: 'cookie-samesite-none',
        title: 'SameSite=None cookie without Secure',
        severity: 'high',
        detail: 'SameSite=None requires Secure; browsers reject the pair, so the cookie may not set at all.',
      });
    }
  }

  if (response.body.length > 0 && /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{16,})/.test(response.body)) {
    findings.push({
      id: 'secret-pattern',
      title: 'Response resembles a credential',
      severity: 'high',
      detail: 'The response body contains a pattern resembling a private key or live credential. Inspect it manually.',
    });
  }

  return findings;
}

/** Analyses the response to the active CORS probe. */
export function auditCors(
  headersInput: Record<string, string>,
  probeOrigin: string,
): SecurityFinding[] {
  const h = headers(headersInput);
  const origin = h['access-control-allow-origin'];
  const credentials = h['access-control-allow-credentials']?.toLowerCase() === 'true';

  if (!origin) {
    return [
      {
        id: 'cors',
        title: 'Probe origin was not allowed',
        severity: 'pass',
        detail: 'No Access-Control-Allow-Origin header was returned to the synthetic origin.',
      },
    ];
  }

  if (origin === probeOrigin && credentials) {
    return [
      {
        id: 'cors-reflection',
        title: 'Arbitrary credentialed origin accepted',
        severity: 'high',
        detail: `The server reflected ${probeOrigin} and allowed credentials. Verify the origin allowlist.`,
      },
    ];
  }

  if (origin === '*') {
    return [
      {
        id: 'cors-wildcard',
        title: 'Any origin may read this response',
        severity: credentials ? 'high' : 'medium',
        detail: credentials
          ? 'Wildcard origin and credentials were both advertised; browsers reject this combination, but it signals a broken policy.'
          : 'Access-Control-Allow-Origin is *. Confirm the response is intended to be public.',
      },
    ];
  }

  return [
    {
      id: 'cors-specific',
      title: 'CORS returned a specific origin',
      severity: origin === probeOrigin ? 'medium' : 'pass',
      detail: `Access-Control-Allow-Origin: ${origin}`,
    },
  ];
}

/**
 * Reads the methods a server advertises from the OPTIONS probe already sent.
 * This is passive enumeration: it reports what the Allow / CORS headers say
 * and never calls those methods.
 */
export function auditMethods(headersInput: Record<string, string>): SecurityFinding[] {
  const h = headers(headersInput);
  const allow = h.allow ?? h['access-control-allow-methods'];
  if (!allow) return [];

  const methods = [
    ...new Set(
      allow
        .split(',')
        .map((method) => method.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (methods.length === 0) return [];

  const findings: SecurityFinding[] = [
    {
      id: 'methods',
      title: 'Advertised HTTP methods',
      severity: 'info',
      detail: `The target advertises: ${methods.join(', ')}.`,
    },
  ];

  if (methods.includes('TRACE')) {
    findings.push({
      id: 'methods-trace',
      title: 'TRACE method advertised',
      severity: 'medium',
      detail: 'TRACE enables Cross-Site Tracing and should be disabled unless specifically required.',
    });
  }

  const writing = methods.filter((method) =>
    ['PUT', 'DELETE', 'PATCH'].includes(method),
  );
  if (writing.length > 0) {
    findings.push({
      id: 'methods-write',
      title: 'State-changing methods advertised',
      severity: 'info',
      detail: `${writing.join(', ')} are advertised; confirm each requires authorization.`,
    });
  }

  return findings;
}

export function securityScore(findings: readonly SecurityFinding[]): number {
  const penalty: Record<SecuritySeverity, number> = {
    pass: 0,
    info: 0,
    low: 4,
    medium: 10,
    high: 22,
  };
  return Math.max(
    0,
    100 - findings.reduce((total, finding) => total + penalty[finding.severity], 0),
  );
}

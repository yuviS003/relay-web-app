import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
  MAX_PASSWORD_LENGTH,
} from '../src/lib/auth/passwords';
import {
  createSessionToken,
  hashSessionToken,
  normaliseEmail,
  readSessionToken,
  sessionCookie,
  clearedSessionCookie,
} from '../src/lib/auth/sessions';
import { CODE_TARGETS, generateCode, shellQuote } from '../src/lib/codegen';

describe('password hashing', () => {
  it('accepts a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterx', stored)).toBe(false);
  }, 20_000);

  it('produces a different hash each time for the same password', async () => {
    // A per-password salt is what stops one cracked hash revealing every user
    // who chose the same password.
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password here', a)).toBe(true);
    expect(await verifyPassword('same password here', b)).toBe(true);
  }, 30_000);

  it('stores its own parameters so cost can be raised later', async () => {
    const stored = await hashPassword('parameters travel with it');
    const [algorithm, cost, blockSize, parallelism] = stored.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(cost)).toBeGreaterThanOrEqual(16_384);
    expect(Number(blockSize)).toBe(8);
    expect(Number(parallelism)).toBe(1);
  }, 20_000);

  it('refuses a tampered record with an absurd cost', async () => {
    // Honouring N=2^30 from a modified row would hang the process, turning a
    // login attempt into a denial of service.
    const forged = `scrypt$1073741824$8$1$${Buffer.from('salt').toString('base64')}$${Buffer.alloc(64).toString('base64')}`;
    expect(await verifyPassword('anything at all', forged)).toBe(false);
  });

  it('rejects malformed records instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword('password12345', bad)).toBe(false);
    }
  });

  it('refuses an over-long password rather than burning CPU', async () => {
    const problem = checkPasswordStrength('a'.repeat(MAX_PASSWORD_LENGTH + 1));
    expect(problem).toBe('too-long');
  });

  it('enforces a length floor and blocks the obvious passwords', () => {
    expect(checkPasswordStrength('short')).toBe('too-short');
    expect(checkPasswordStrength('   ')).toBe('whitespace-only');
    expect(checkPasswordStrength('password123')).toBe('too-common');
    expect(checkPasswordStrength('a reasonable passphrase')).toBeNull();
  });
});

describe('sessions', () => {
  it('stores only a hash of the token', () => {
    const { token, tokenHash } = createSessionToken();
    // A database leak must not hand over usable sessions.
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toHaveLength(64);
    expect(hashSessionToken(token)).toBe(tokenHash);
  });

  it('issues unguessable, cookie-safe tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { token } = createSessionToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
  });

  it('sets HttpOnly and SameSite, and Secure only in production', () => {
    const production = sessionCookie('abc', true);
    expect(production).toContain('HttpOnly');
    expect(production).toContain('SameSite=Lax');
    expect(production).toContain('Secure');

    // Secure on plain-HTTP localhost would be dropped, so login would appear
    // to silently fail in development.
    expect(sessionCookie('abc', false)).not.toContain('Secure');
  });

  it('expires the cookie on sign out', () => {
    expect(clearedSessionCookie(false)).toContain('Max-Age=0');
  });

  it('reads its own cookie out of a crowded header', () => {
    const { token } = createSessionToken();
    expect(readSessionToken(`other=1; wac_session=${token}; another=2`)).toBe(token);
  });

  it('ignores a malformed or absent token', () => {
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken('wac_session=')).toBeNull();
    // Refuse implausible values rather than passing them to a query.
    expect(readSessionToken('wac_session=short')).toBeNull();
    expect(readSessionToken("wac_session=has spaces and ' quotes")).toBeNull();
  });

  it('normalises email and rejects nonsense', () => {
    expect(normaliseEmail('  Yuvraj@Example.COM ')).toBe('yuvraj@example.com');
    for (const bad of ['', 'no-at-sign', 'a@b', 'a@@b.com', 'a b@c.com', 42]) {
      expect(normaliseEmail(bad), String(bad)).toBeNull();
    }
  });
});

describe('code generation', () => {
  const request = {
    method: 'POST',
    url: 'https://api.example.com/things?q=1',
    headers: [
      { name: 'content-type', value: 'application/json', enabled: true },
      { name: 'x-off', value: 'ignored', enabled: false },
    ],
    body: '{\n  "a": 1\n}',
  };

  it('quotes safely for a shell', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    // The attack this prevents: the snippet runs on the user's own machine.
    expect(shellQuote("a'; rm -rf ~; '")).toBe(`'a'\\''; rm -rf ~; '\\'''`);
  });

  it('quotes so a real shell reproduces the value exactly', () => {
    /*
     * Pattern-matching the escaped string is guesswork: correct POSIX quoting
     * of a quote produces `'\''`, which ends in two quotes and trips naive
     * regexes. The only trustworthy check is to hand it to a shell and see
     * what comes back.
     */
    const hostile = [
      "https://x.test/'; rm -rf ~; '",
      '$(whoami)',
      '`id`',
      'a"b\'c',
      'semi; colon && and || or | pipe',
      '$HOME ${PATH}',
      'newline\nhere',
    ];

    for (const value of hostile) {
      const echoed = execFileSync('bash', ['-c', `printf %s ${shellQuote(value)}`], {
        encoding: 'utf8',
      });
      // Byte-identical means nothing expanded, substituted, or executed.
      expect(echoed, value).toBe(value);
    }
  });

  it('produces a curl command a shell parses as one argument per flag', () => {
    const code = generateCode('curl', {
      ...request,
      url: "https://x.test/'; touch /tmp/wac-pwned; '",
    });

    // Replace curl with a printf that reveals the parsed argv, then confirm
    // the injected command never became a command.
    const argv = execFileSync(
      'bash',
      ['-c', `set -- ${code.replace(/^curl /, '').replaceAll('\\\n', ' ')}; printf '%s\\n' "$@"`],
      { encoding: 'utf8' },
    );
    expect(argv).toContain("https://x.test/'; touch /tmp/wac-pwned; '");
    expect(existsSync('/tmp/wac-pwned')).toBe(false);
  });

  it('builds curl with method, headers, and a raw body', () => {
    const code = generateCode('curl', request);
    expect(code).toContain('curl -X POST');
    expect(code).toContain("-H 'content-type: application/json'");
    // --data, unlike --data-raw, strips newlines and mangles formatted JSON.
    expect(code).toContain('--data-raw');
    expect(code).not.toContain('x-off');
  });

  it('omits a body for GET even when one is typed', () => {
    const code = generateCode('curl', { ...request, method: 'GET' });
    expect(code).not.toContain('--data-raw');
  });

  it('builds fetch with JSON-escaped values', () => {
    const code = generateCode('fetch', request);
    expect(code).toContain('await fetch("https://api.example.com/things?q=1"');
    expect(code).toContain('"method": "POST"'.replace('"method"', 'method'));
    // Newlines inside the body survive as an escape, not a line break.
    expect(code).toContain('\\n');
  });

  it('builds python requests with the right verb', () => {
    const code = generateCode('python', request);
    expect(code).toContain('import requests');
    expect(code).toContain('requests.post(');
    expect(code).toContain('data=data');
  });

  it('builds httpie, piping the body through stdin', () => {
    const code = generateCode('httpie', request);
    expect(code).toContain('http POST');
    expect(code).toContain("'content-type:application/json'");
    expect(code).toContain('| http');
  });
});

describe('code generation across every target', () => {
  /*
   * One request with every quoting hazard in it at once: a shell
   * metacharacter, both quote styles, a backslash, a newline, and a `$` that
   * three of the targets would otherwise interpolate. A generator that gets
   * this wrong produces a snippet that either fails to parse or — the reason
   * this matters — executes something.
   */
  const nasty = {
    method: 'POST',
    url: "https://api.example/x?q='; rm -rf ~; '",
    headers: [
      { name: 'x-note', value: 'it\'s "quoted" and $PATH C:\\temp', enabled: true },
      { name: 'x-off', value: 'never', enabled: false },
      { name: '', value: 'nameless', enabled: true },
    ],
    body: '{\n  "shell": "$(whoami)",\n  "quote": "it\'s"\n}',
  };

  const targets = [
    'curl',
    'wget',
    'httpie',
    'powershell',
    'fetch',
    'axios',
    'python',
    'httpx',
    'go',
    'java',
    'csharp',
    'php',
    'ruby',
    'rust',
    'swift',
    'kotlin',
    'dart',
  ] as const;

  it('offers a label and a group for every target it can generate', () => {
    expect(CODE_TARGETS.map((target) => target.id).sort()).toEqual([...targets].sort());
    for (const target of CODE_TARGETS) {
      expect(target.label, target.id).not.toBe('');
      expect(target.group, target.id).not.toBe('');
    }
  });

  it('emits the method, the url and the enabled headers, and nothing else', () => {
    for (const target of targets) {
      const code = generateCode(target, nasty);
      expect(code, target).toContain('api.example');
      expect(code, target).toContain('x-note');
      // A disabled row and a nameless row are not part of the request.
      expect(code, target).not.toContain('x-off');
      expect(code, target).not.toContain('nameless');
    }
  });

  it('never leaves a raw single quote inside a single-quoted shell word', () => {
    /*
     * The three shell targets share the hazard. Each closes, escapes and
     * reopens, so the quote that would end the word early appears only as
     * '\'' — and the unescaped form, which is what would hand the rest of the
     * value to the shell as code, appears nowhere.
     */
    for (const target of ['curl', 'wget', 'httpie'] as const) {
      const code = generateCode(target, nasty);
      expect(code, target).toContain(`'\\''`);
      expect(code, target).not.toContain("q='; rm");
      expect(code, target).not.toContain("it's \"quoted\"");
    }
  });

  it('doubles an embedded quote for PowerShell', () => {
    const code = generateCode('powershell', nasty);
    expect(code).toContain("''");
    expect(code).toContain('Invoke-RestMethod');
  });

  it('escapes the backslash before the quote for PHP and Ruby', () => {
    for (const target of ['php', 'ruby'] as const) {
      const code = generateCode(target, nasty);
      // C:\temp must survive as a literal backslash, and it's must not end
      // the string it sits in.
      expect(code, target).toContain('C:\\\\temp');
      expect(code, target).toContain("it\\'s");
    }
  });

  it('stops Kotlin and Dart interpolating a dollar sign', () => {
    for (const target of ['kotlin', 'dart'] as const) {
      const code = generateCode(target, nasty);
      expect(code, target).toContain('\\$PATH');
      expect(code, target).not.toMatch(/[^\\]\$PATH/);
    }
  });

  it('keeps a body out of a GET, in every target', () => {
    for (const target of targets) {
      const code = generateCode(target, { ...nasty, method: 'GET' });
      expect(code, target).not.toContain('whoami');
    }
  });

  it('puts a content type on the C# body rather than the request headers', () => {
    // HttpClient throws if a content header is added to the request itself,
    // so this one is a correctness check, not a style one.
    const code = generateCode('csharp', {
      ...nasty,
      headers: [{ name: 'content-type', value: 'application/json; charset=utf-8', enabled: true }],
    });
    expect(code).toContain('new StringContent(');
    expect(code).toContain('"application/json"');
    expect(code).not.toContain('Headers.TryAddWithoutValidation("content-type"');
  });
});

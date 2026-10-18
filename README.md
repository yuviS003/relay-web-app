# Web API client

Compose and send HTTP requests from a browser tab. Collections, environments,
encrypted secrets, sandboxed pre-request scripts, and response analysis — SEO
grading, structured extraction, a non-destructive security audit, and a
one-click report that runs them together.

Runs locally with no accounts. Deployed on Vercel Hobby with MongoDB Atlas
Free:

- **Live:** https://relay-web-app-sigma.vercel.app
- **Source:** https://github.com/yuviS003/relay-web-app

The live instance runs in account mode: browsing and sending work as a guest
under a smaller quota, and an account is needed only to save work.

## Why this is not just a form with a fetch call

A browser tab **cannot** send arbitrary cross-origin requests. CORS is enforced
by the browser, and no third-party API is going to allowlist your tool. Every
request therefore has to be relayed by the server — which is exactly why
Postman's web version makes you install a desktop agent.

**That relay is the entire security problem.** An unrestricted one is a
server-side request forgery weapon: point it at `169.254.169.254` to read cloud
instance credentials, or at `127.0.0.1` to sweep the private network the server
sits inside. Most of the engineering here is making the relay safe.

### The guard decides on addresses, not names

`src/lib/proxy/guard.ts`

- **Resolved address, never the hostname.** A name blocklist is defeated in one
  move: `localtest.me` and countless public DNS records resolve to `127.0.0.1`.
- **Every answer is checked, not the first.** A hostile record can return one
  public and one private address; connecting to whichever the OS picked is a
  coin flip the attacker is happy to take.
- **IPv4-mapped IPv6 is unwrapped.** `::ffff:127.0.0.1` is loopback in a
  costume, and a guard that only pattern-matches IPv6 prefixes waves it
  through. Mapped forms are then refused outright, even when they wrap a public
  address — the notation shows up only in bypass attempts, and allowing it
  would oblige the unwrapping path to stay flawless forever to remain safe.
- **Strict octet parsing.** `Number()` accepts `0177.0.0.1` and `1e2.1.1.1`; a
  lenient parser is itself the bypass.

### The relay pins the connection

`src/lib/proxy/relay.ts`

- **The socket connects to the approved address.** `fetch` gives no control
  over DNS, so it would resolve a second time and reopen the rebinding hole the
  guard just closed. This uses `node:http` with a `lookup` hook; the Host
  header and TLS SNI still carry the hostname, so virtual hosting and
  certificate validation keep working.
- **Every redirect is re-guarded.** A legitimate URL that answers
  `302 Location: http://169.254.169.254/` defeats any one-time check.
- **Size cap enforced while streaming.** `Content-Length` is attacker-supplied
  and may be absent or lie, so bytes are counted as they arrive.
- **A total time budget**, not an idle timeout — one byte per second would
  satisfy an idle timeout forever.
- **Header hygiene.** `Host` is derived from the target, hop-by-hop headers are
  stripped, and any value containing CRLF is dropped because a newline lets the
  caller inject a second request onto the connection.
- **A 302 drops the body and switches to GET**, since replaying a POST body to
  a redirect target turns a redirect into an unintended write elsewhere.

### Scripts run in a real sandbox

`src/lib/scripting/sandbox.ts`

`eval` and `new Function` would give a saved request full access to the server
process. Scripts run in **QuickJS compiled to WebAssembly** instead: no
network, no filesystem, no timers, no host bindings. The only channel is a JSON
string in and a JSON string out. An interrupt handler stops a script after 1s
(so `while(true){}` is survivable) and a memory ceiling stops one that
allocates until the process dies. Tests assert `require`, `process`, `fetch`
and `XMLHttpRequest` are all `undefined` inside the VM.

### Secrets are encrypted in the browser

`src/lib/crypto/secrets.ts`

AES-GCM with a PBKDF2-derived key (310k iterations, per-environment salt). The
passphrase never leaves the browser and the derived key is non-extractable, so
a later XSS can use it but cannot exfiltrate it. The server stores ciphertext
it has no key for.

**What this does not protect:** the proxy necessarily sees a decrypted token
while forwarding the request, because that is the job. The guarantee is about
the stored copy, not transit. The UI says so rather than implying more.

## Running locally

```bash
npm install
npm run dev        # http://localhost:3000
```

No database needed — without `MONGODB_URI` the workspace is in memory, seeded
with three example requests including one that demonstrates the proxy refusing
an SSRF attempt.

```bash
npm test           # 439 tests (8 run against a live Atlas cluster, skipped if unreachable)
npm run verify     # typecheck + tests + production build
```

## What you need to supply

| | needed for | cost |
| --- | --- | --- |
| Nothing | running locally | — |
| **MongoDB Atlas** cluster + `MONGODB_URI` | collections surviving a restart | free (512 MB) |
| **Upstash Redis** + `UPSTASH_REDIS_REST_*` | a rate limit that holds across instances | free tier |
| **Vercel** account | public deployment | free (Hobby) |

```bash
npm i -g vercel
vercel link
vercel env add MONGODB_URI production
vercel --prod
```

## Accounts

Email and password, with scrypt-hashed passwords and revocable opaque session
tokens (only a SHA-256 of each token is stored, so a database leak yields no
usable sessions). Google and GitHub OAuth buttons become active when their
client id/secret pairs are configured.

The `redirect_uri` sent to a provider must match a registered entry exactly,
origin included. `APP_URL` sets that origin when a proxy hides the real one;
leave it empty locally and the callback follows whatever port you run on. A
value that names a different origin than the request arrived on — or one
missing its scheme — is reported on the sign-in card with the URI to register,
rather than sending you to a bare provider "Error 400".

Register, for each provider you enable:

```
<origin>/api/auth/oauth/google/callback
<origin>/api/auth/oauth/github/callback
```

For the deployment above that means:

```
https://relay-web-app-sigma.vercel.app/api/auth/oauth/google/callback
https://relay-web-app-sigma.vercel.app/api/auth/oauth/github/callback
```

Google accepts a list, so the localhost entry can stay alongside it. A GitHub
OAuth app holds a single callback URL, so local development needs its own app
rather than editing this one. Note also that a passkey is bound to the origin
it was registered on: one created against localhost will not work on the
deployed domain. Collections and environments are scoped
per owner: the store is constructed *for* an owner and has no unscoped read, so
a forgotten check cannot leak another user's work.

With Atlas available, unsigned visitors can continue as guests: they receive
the sample workspace and can send, test and analyse quota-limited requests.
Any persistence action opens sign-in; guest data is never written to MongoDB.

### The sample workspace

A new account — and a guest — starts with six collections, one per feature
family, each pointing at a public demo service and carrying assertions that
pass when the feature works (`src/lib/store/samples.ts`):

| Collection | What it demonstrates |
| --- | --- |
| Starter | The relay, an SSRF refusal, a pre-request script, assertions |
| Chained run | A sign-in whose token and user id are captured and reused |
| Auth helpers | Basic, bearer, AWS SigV4 and OAuth2 client credentials |
| Cookies | A `Set-Cookie` arriving on a redirect hop, then sent back |
| Viewers and history | JSON tree, sandboxed HTML preview, hexdump, diffing |
| GraphQL and streaming | A document with variables, and server-sent events |

Credentials are written as `{{variables}}` with the values in each
collection's own variables — the habit a real collection should copy. They are
published demo credentials (postman-echo, dummyjson, Duende's demo
IdentityServer) or AWS's documented example key pair; none is a real secret.
Seeding happens once per owner and never overwrites an existing workspace, so
deleting the samples keeps them deleted.

### Rate limiting and caller identity

A token bucket caps the relay and the sign-in endpoint. Signed-in callers are
keyed by account id; guests are keyed by address, and a guest gets a smaller
burst than an account because a guest costs nothing to become.

The identity is deliberately hard to forge. `X-Forwarded-For` is a request
header, so a direct client can send anything — reading its first entry, the
usual shortcut, would let a caller mint a fresh allowance per request. Instead:

- A platform header the edge overwrites (`x-vercel-forwarded-for`,
  `cf-connecting-ip`, `fly-client-ip`) is used when present.
- Otherwise `X-Forwarded-For` is read **from the right**, skipping exactly
  `TRUSTED_PROXY_HOPS` trusted proxies. The default of `0` means the header is
  not trusted at all.
- With no trustworthy source, the caller is not identified and charged to a
  single shared bucket. That is stricter than per-caller limiting, and it
  cannot be escaped by rotating a header.

Set `TRUSTED_PROXY_HOPS` to the real number of proxies in front of the app and
no higher: an inflated value hands the forged part of the chain back to the
client.

Without `MONGODB_URI` the app runs in **local mode** — one unauthenticated
workspace on your machine. That split is deliberate: a login that forgets you
on restart is worse than no login.

## Honest status

**Built and tested (439 tests):** SSRF guard, pinned relay with redirect
re-validation and resource caps, QuickJS pre-request and post-response
assertion sandboxes, a Redis-backed per-caller quota keyed on an
unforgeable caller identity, default headers on newly created requests,
browser-side secret encryption, saves that never overwrite edits made while
the write is in flight,
per-account collections and environments with Mongo and in-memory stores,
user-created collections, collection variables layered under the environment
and under captures, a collection runner that chains requests by lifting values
out of one response into the next and the same runner headless with JUnit
output (`npm run collection`), response history in IndexedDB with structural
JSON diffing between two runs, OpenAPI 3 and Postman v2.1 import, request auth
applied server-side after substitution (basic, bearer, AWS SigV4, OAuth 2
client-credentials and refresh with a token cache), a scoped in-memory cookie
jar that collects Set-Cookie across redirects, a streaming relay and live event panel for
server-sent events, with the same guard and caps, a GraphQL mode with
introspection and error surfacing, body viewers (JSON tree with a shared path
filter, sandboxed HTML preview, hexdump), passkeys for passwordless sign-in,
account export and deletion, password reset by email when a provider is
configured, an accessibility gate that fails the browser suite on serious axe
violations,
quota-limited guest relay access with sign-in required only for persistence,
email/password plus configurable Google and GitHub OAuth, optional TOTP
two-factor authentication with single-use recovery codes (offered after signing
in, skippable, and enforced on provider sign-ins too), a settings surface for
the profile, password, second factor and other sessions, an interactive guided
tour for new visitors and new accounts, password visibility
controls, request rename and delete through a persistent overflow menu that
asks in the app's own dialogs rather than a browser `confirm()`, sidebar
reordering by drag and drop with moves between collections (and the same moves
in the row menu, because drag and drop has no keyboard equivalent),
keyboard shortcuts (Ctrl/Cmd+S to save, Ctrl/Cmd+Enter to send, Ctrl/Cmd+K for
the palette) that work while a field is focused, cURL import, code generation for seventeen targets (cURL, wget, HTTPie, PowerShell, fetch, axios, requests, httpx, Go, Java, C#, Rust, Swift, Kotlin, PHP, Ruby, Dart) with {{variables}} resolved,
automatic test-case generation from a response, per-format body drafts with
JSON/XML/form/text formatting and minification, request tabs that retain
unsaved edits and their own response for the session, bounded repeated-hit testing with delay/concurrency and latency
percentiles, non-destructive security auditing (response headers including CSP
quality, HSTS depth, permissions and cross-origin policies and cookie flags,
CORS, advertised-method enumeration, plus body-level checks for mixed content,
reverse-tabnabbing, insecure password forms, missing Subresource Integrity and
the third-party script surface), SEO analysis and grading (title, description,
canonical, charset, indexability, headings, alt and image dimensions, Open
Graph, Twitter Card, structured data, text-to-HTML ratio and link profile),
single-page extraction (links, images, headings, tables, metadata, text and
arbitrary CSS selectors), a one-click combined report that runs all of the
above in a single pass, JSON and CSV export of the SEO, security and combined
reports, OpenRouter’s free router and local Ollama presets in the optional
bring-your-own-key AI assist, installable PWA support, request/response tabs,
header suggestions, light/dark themes, command palette, designed modal flows,
a connection trace, and copying a response body, headers or the whole exchange, a network indicator that grades the connection from real sends and separates target time from relay time, a view of the request as the relay actually sent it — substituted, with server-applied auth, credentials hidden until asked for. New accounts receive a six-collection sample workspace
exactly once. The MongoDB path is covered by eight tests against a real cluster
and skips itself when no `MONGODB_URI` is present.

The SEO, extraction and body-security analysers run **in the browser**, on the
response the relay already returned. The server gains no new way to reach the
network, so these features inherit the SSRF guard, authentication and quota of
the request that produced the response rather than adding a second fetch path.
The AI assist is opt-in: OpenRouter’s free router, a local Ollama model, or any
OpenAI-compatible endpoint. The key stays in the current tab session, calls route through
the guarded relay, and credential-shaped headers are redacted before request
details are sent. Deterministic response-based test generation remains free,
local, and keyless.

A collection can also be run headless, against any instance, by the same runner
the UI uses:

```bash
npm run collection -- --collection ./collection.json --base http://localhost:3007 \
  --junit ./reports/relay.xml --bail
```

It exits non-zero when a step fails, so a pipeline fails with the suite.

A separate browser suite covers the assembled application against a running
instance:

```bash
BASE_URL=http://localhost:3007 npm run test:e2e
```

It creates and removes its own Atlas account and verifies guest traversal with
a sign-in-on-save gate, password visibility, auth, persistence, request rename
and delete, drag-and-drop reordering and cross-collection moves that survive a
reload, per-format body drafts and formatting, modals, tabs, successful
HTTPS relay, SSRF refusal, traffic testing, security audit, SEO analysis,
extraction, the one-click combined report, themes, mobile overflow, and PWA
manifest/icons/service worker.

It also drives the later features against live endpoints: two runs of the same
request recorded and diffed, the JSON tree and its path filter and a hexdump of
the same body, a bearer token resolved from a pre-request script and applied by
the relay, a `Set-Cookie` captured from a 302 and offered back only to the host
that set it, an OpenAPI document imported into a collection with its path
template as a variable, and the streaming relay forwarding chunks while still
refusing a link-local target. Then axe-core runs against the assembled page and
against an open dialog, and any serious or critical violation fails the run —
which is how the tab strip's invalid `tablist` structure and four light-theme
contrast failures were found.

The onboarding and account flows are exercised for real rather than mocked. The
suite walks the guided tour as a guest and again as a new account, enrolls a
second factor by reading the secret off the setup dialog and generating codes
from an independent RFC 6238 implementation in the harness, checks that a wrong
code does not enable it, signs in with a code and then with a recovery code,
and uses the settings panel to change the password and turn the factor back
off. A virtual authenticator over CDP covers the passkey ceremonies, so
registration and a passwordless sign-in are exercised against real signatures
rather than stubbed.

Thirty-seven checks run in total, and five of them are structural rather than
functional: every dialog's stacked blocks must be evenly spaced, nothing in the
sidebar may be wider than the sidebar, the tour must actually cover the
interface it dims, axe-core must find no serious or critical violation in the
assembled page or in an open dialog, and the run fails if the application opens
a browser `alert`, `confirm` or `prompt` at any point.

The half-finished sign-in is checked as a boundary, not just a screen: while a
second factor is outstanding the caller must read as anonymous, see only the
guest preview rather than the account's collections, and be refused any write.

**Deliberately not built:**

- **No active exploitation.** The security tooling is assessment only: it reads
  what a target returned and sends at most one synthetic OPTIONS probe. It does
  not fuzz, guess paths, attempt credentials, or send injection payloads.
  Turning the guarded relay into a payload cannon aimed at arbitrary targets
  would make a public deployment an attack proxy — the exact thing the relay
  exists to prevent — so that is out of scope by design, not by omission.
- **Extraction is single-page.** It parses the one response in hand and does
  not crawl or follow links; a crawler would owe robots.txt and rate-limiting
  obligations this does not take on.
- **The external AI assist is opt-in.** There is no bundled paid key or hosted
  model. OpenRouter’s free router and local Ollama are presets, and any
  OpenAI-compatible endpoint can be used. When an external provider is used,
  request details are sent to it with credential headers redacted.

**Not built:**

- **Rate limiting needs configuration to be global.** With
  `UPSTASH_REDIS_REST_URL` and `_TOKEN` set, the token bucket lives in Redis and
  every instance decrements the same counter. Without them it falls back to an
  in-memory bucket that each instance keeps separately and a cold start resets,
  which is fine locally but not for a public deployment. The same fallback
  applies if Redis is unreachable: the endpoint stays limited per instance
  rather than becoming unlimited. Use the **REST** URL, not the `redis-cli`
  connection string — a value that is not an http(s) URL is ignored with a
  warning, and a store that fails is skipped for 30 seconds rather than
  costing every request its timeout.
- **Streaming is a separate path, not the default.** The ordinary relay buffers
  in order to enforce the size cap, so an SSE endpoint sent with Send waits for
  the stream to close and can hit the time budget. The Stream tab talks to
  `/api/relay/stream` instead and appends events as they arrive, under the same
  guard, pinned address and byte cap, with a longer budget.
- **Password reset needs a mail provider.** The token machinery is built —
  opaque, hashed at rest, single use, 30 minutes, every session dropped on
  completion — but delivery needs `MAIL_FROM` plus either `RESEND_API_KEY` or
  `BREVO_API_KEY` (name one with `MAIL_PROVIDER` when both are set). Without
  them the endpoint reports `mailerConfigured: false` and the UI says email
  delivery is not configured, rather than claiming a link is on its way. Both
  providers have a free tier, but sending to arbitrary recipients needs a
  domain verified with the provider, which no free tier waives: on Resend an
  unverified account can send from `onboarding@resend.dev` only to its own
  account address, which is enough to demonstrate the flow end to end.
- **No SMS second factor**, deliberately. TOTP and passkeys only.
- **Imports are JSON only.** An OpenAPI document in YAML has to be converted
  first: a half-working YAML parser is worse than a clear message. Postman
  scripts are imported as comments, not translated, because they are written
  against the `pm.*` API this client does not implement.
- **GraphQL has no schema-aware autocomplete.** Introspection lists fields and
  builds runnable skeletons; it does not complete selection sets as you type.
- **The cookie jar has no public suffix list.** A `Domain` attribute must cover
  the host and contain a dot, which is the conservative rule without shipping
  the list.

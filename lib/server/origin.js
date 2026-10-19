// Request-origin checks: localhost-only Host, and same-origin Server Actions.
//
// Host allowlist (DNS rebinding): the server listens on 127.0.0.1 only, but a malicious
// website can make its own domain resolve to 127.0.0.1. The victim's browser then sends
// requests with `Host: evil.example:3000` and a *matching* Origin, so a same-origin check
// alone would pass. Every Server Action and every session lookup therefore also requires
// the Host to be a localhost name (any port).
//
// Same origin: Next.js rejects a Server Action whose Origin differs from the Host, but it
// lets a request with NO Origin header through (it only logs a warning). Browsers always
// send Origin on cross-site POSTs, so that is not a browser CSRF route, but sensitive
// actions should not depend on it: they require Origin to be present AND to match Host.

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export class CrossOriginRequest extends Error {
  constructor(reason) {
    super(`cross-origin or origin-less request refused (${reason})`);
    this.name = 'CrossOriginRequest';
    this.reason = reason;
  }
}

/** True if a Host header value is localhost / 127.0.0.1 / [::1], with an optional port. */
export function isLocalHost(host) {
  if (typeof host !== 'string' || host === '') return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  // Rejects userinfo, paths and anything else that does not round-trip exactly.
  return LOCAL_HOSTNAMES.has(parsed.hostname) && parsed.host === host.toLowerCase();
}

/** Throws CrossOriginRequest unless the Host header is a localhost address. */
export function assertLocalHost(headers) {
  if (!isLocalHost(headers.get('host'))) throw new CrossOriginRequest('Host is not a localhost address');
}

/** Throws CrossOriginRequest unless Host is local and Origin is present and matches it. */
export function assertSameOrigin(headers) {
  const origin = headers.get('origin');
  const host = headers.get('host');
  if (!origin) throw new CrossOriginRequest('missing Origin');
  if (!host) throw new CrossOriginRequest('missing Host');
  assertLocalHost(headers);
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new CrossOriginRequest('malformed Origin');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host !== host.toLowerCase()) {
    throw new CrossOriginRequest('Origin does not match Host');
  }
}

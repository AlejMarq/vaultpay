// Same-origin check for Server Actions, on top of Next.js's own check.
//
// Next.js rejects a Server Action whose Origin differs from the Host, but it lets a
// request with NO Origin header through (it only logs a warning). Browsers always send
// Origin on cross-site POSTs, so that is not a browser CSRF route, but authentication
// actions should not depend on it: they require Origin to be present AND to match Host.

export class CrossOriginRequest extends Error {
  constructor(reason) {
    super(`cross-origin or origin-less request refused (${reason})`);
    this.name = 'CrossOriginRequest';
    this.reason = reason;
  }
}

/** Throws CrossOriginRequest unless Origin is present and matches Host. */
export function assertSameOrigin(headers) {
  const origin = headers.get('origin');
  const host = headers.get('host');
  if (!origin) throw new CrossOriginRequest('missing Origin');
  if (!host) throw new CrossOriginRequest('missing Host');
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

// Next.js wrappers around the DAL for pages and Server Actions. Every call reads the
// session and the identity database again (no caching of authorization decisions).

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { assertNotBuilding, getAuth } from './auth.js';
import { assertMfaVerified, AccessDenied, landingPath, resolveViewer } from './dal.js';
import { defaultDataDir } from './db/definitions.js';
import { openIdentityDb } from './db/index.js';

const READONLY_IDENTITY = Symbol.for('vaultpay.identity.readonly');

// The DAL reads identity data over its own read-only connection (D3): only Better Auth's
// connection may write sessions.
export function readOnlyIdentityDb() {
  assertNotBuilding();
  globalThis[READONLY_IDENTITY] ??= openIdentityDb({ dataDir: defaultDataDir(), readonly: true });
  return globalThis[READONLY_IDENTITY];
}

/** The current viewer or null. `refresh` only inside Server Actions. */
export async function getViewer({ refresh = false } = {}) {
  // Read the request first: headers() is a request-time API, so `next build` stops
  // prerendering here – before any database is opened or Better Auth is started.
  const requestHeaders = new Headers(await headers());
  // Use the cookie store, not the raw Cookie header: after a Server Action changes the
  // session (enrollment replaces it), the page re-renders in the same request, and only
  // cookies() reflects the cookie Better Auth just set.
  requestHeaders.set('cookie', (await cookies()).toString());
  return resolveViewer({ auth: await getAuth(), identityDb: readOnlyIdentityDb(), headers: requestHeaders, refresh });
}

/** Signed in (MFA may still be pending) – otherwise redirect to /login. */
export async function requireViewer() {
  const viewer = await getViewer();
  if (!viewer) redirect('/login');
  return viewer;
}

/**
 * Protected functionality: signed in AND MFA completed in this session. A password-only
 * session is sent to /mfa; there is no other way through.
 */
export async function requireMfaVerifiedViewer({ refresh = false } = {}) {
  const viewer = await getViewer({ refresh });
  try {
    return assertMfaVerified(viewer);
  } catch (err) {
    if (err instanceof AccessDenied) redirect(landingPath(viewer));
    throw err;
  }
}

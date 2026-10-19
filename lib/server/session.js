// Next.js wrappers around the DAL for pages and Server Actions. Every call reads the
// session and the identity database again (no caching of authorization decisions).

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { assertNotBuilding, getAuth } from './auth.js';
import { AccessDenied, assertCustomer, assertMfaVerified, assertSupport, deniedPath, resolveViewer } from './dal.js';
import { defaultDataDir } from './db/definitions.js';
import { SESSION_COOKIE } from './auth-config.js';
import { fetchCustomerBalance, sessionTokenFromCookie } from './balance.js';
import { assertVerifiedCustomer } from './eligibility.js';
import { isLocalHost } from './origin.js';
import { servicePort } from '../services/ports.js';
import { loadProcessEnv } from '../services/process-env.js';
import { openIdentityDb, openTransactionDb } from './db/index.js';

const READONLY_IDENTITY = Symbol.for('vaultpay.identity.readonly');
const READONLY_TRANSACTION = Symbol.for('vaultpay.transaction.readonly');

// Reads go through read-only connections (D3): SQLite itself refuses writes on them.
// Only Better Auth's connection writes identity data (sessions); only the audit writer
// (lib/server/audit.js) writes to the transaction DB from Next.js.
export function readOnlyIdentityDb() {
  assertNotBuilding();
  globalThis[READONLY_IDENTITY] ??= openIdentityDb({ dataDir: defaultDataDir(), readonly: true });
  return globalThis[READONLY_IDENTITY];
}

export function readOnlyTransactionDb() {
  assertNotBuilding();
  globalThis[READONLY_TRANSACTION] ??= openTransactionDb({ dataDir: defaultDataDir(), readonly: true });
  return globalThis[READONLY_TRANSACTION];
}

/** The current viewer or null. `refresh` only inside Server Actions. */
export async function getViewer({ refresh = false } = {}) {
  // Read the request first: headers() is a request-time API, so `next build` stops
  // prerendering here – before any database is opened or Better Auth is started.
  const requestHeaders = new Headers(await headers());
  // DNS rebinding: a request addressed to a non-localhost name never has a session.
  if (!isLocalHost(requestHeaders.get('host'))) return null;
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

// Runs a DAL check on the current viewer; a refusal redirects (login, MFA, access denied).
async function requireWith(check, options) {
  const viewer = await getViewer(options);
  try {
    return check(viewer);
  } catch (err) {
    if (err instanceof AccessDenied) redirect(deniedPath(err));
    throw err;
  }
}

/** Signed in AND MFA completed in this session (any role). */
export const requireMfaVerifiedViewer = (options) => requireWith(assertMfaVerified, options);

/** An active customer whose session completed MFA. */
export const requireCustomer = (options) => requireWith(assertCustomer, options);

/** An active support_readonly ops user whose session completed MFA. */
export const requireSupport = (options) => requireWith(assertSupport, options);

const WEB_CREDENTIALS = Symbol.for('vaultpay.web.tls');

// Next.js's own client certificate (CN=vaultpay-web) for Identity and CBI.
function webCredentials() {
  assertNotBuilding();
  globalThis[WEB_CREDENTIALS] ??= loadProcessEnv('web', { dataDir: defaultDataDir() }).tls;
  return globalThis[WEB_CREDENTIALS];
}

/**
 * The customer's balance for /wallet: { available: true, balanceCents, … } or
 * { available: false } – the reason is logged on the server, never shown.
 */
export async function loadCustomerBalance(viewer) {
  const jar = await cookies();
  let result;
  try {
    result = await fetchCustomerBalance(viewer, {
      sessionToken: sessionTokenFromCookie(jar.get(SESSION_COOKIE)?.value),
      credentials: webCredentials(),
      identityPort: servicePort('identity'),
      cbiPort: servicePort('cbi'),
    });
  } catch (err) {
    if (err instanceof AccessDenied) throw err;
    result = { available: false, reason: err.code ?? 'error' };
  }
  if (!result.available) console.error(`[balance] unavailable: ${result.reason}`);
  return result.available ? result : { available: false, inactiveWallet: result.reason === 'wallet_inactive' };
}

/**
 * A customer allowed to send money right now: MFA completed in this session, active
 * customer, active wallet they own, latest KYC approved – read from the database at this
 * moment. Returns { viewer, eligibility }; an ineligible customer is sent to /send, which
 * explains why. Step 5 transfer actions call this again just before creating a transfer.
 */
export const requireVerifiedCustomer = (options) =>
  requireWith((viewer) => assertVerifiedCustomer(viewer, readOnlyIdentityDb()), options);

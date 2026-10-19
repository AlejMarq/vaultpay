// The Next.js app's Better Auth instance, connected to the real identity database.
//
// Nothing happens at import time: the database is opened and Better Auth is created on
// first use, so `next build` never needs data/. One instance per process, kept on
// globalThis so development hot reloads do not open extra connections.
//
// Server-side only (better-sqlite3, secrets). Authentication runs through Server Actions
// calling auth.api – no public Better Auth HTTP routes are mounted (Step 3, decision 2).

import { betterAuth } from 'better-auth';

import { buildAuthOptions } from './auth-config.js';
import { getWebConfig, TRUSTED_ORIGINS } from './config.js';
import { defaultDataDir } from './db/definitions.js';
import { openIdentityDb } from './db/index.js';

/**
 * Creates a Better Auth instance on the identity DB of `dataDir`. Waits for Better Auth's
 * own schema check, so a mismatched database fails here instead of in the background.
 * Returns { auth, db, close }.
 */
export async function createAuth({ dataDir = defaultDataDir(), plugins = [] } = {}) {
  const config = getWebConfig({ dataDir });
  const db = openIdentityDb({ dataDir });
  try {
    const options = buildAuthOptions({ database: db, secret: config.BETTER_AUTH_SECRET, baseURL: config.BETTER_AUTH_URL });
    const auth = betterAuth({
      ...options,
      trustedOrigins: [...TRUSTED_ORIGINS],
      plugins: [...options.plugins, ...plugins],
    });
    await (await auth.$context).checkSchema?.();
    return { auth, db, close: () => db.close() };
  } catch (err) {
    db.close();
    throw err;
  }
}

const INSTANCE = Symbol.for('vaultpay.auth');

/**
 * `next build` must never open data/ (databases, secrets). Pages read the request before
 * reaching the DAL, which ends prerendering; if a future change breaks that ordering,
 * this turns it into a build failure instead of a silent database access.
 */
export function assertNotBuilding() {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('VaultPay: data/ must not be accessed during `next build` – read the request (headers()/connection()) first');
  }
}

/**
 * The app-wide instance ({ auth, db }; `getAuth()` returns just `auth`). `nextCookies` (Better Auth's Next.js plugin, which writes
 * Set-Cookie headers through next/headers inside Server Actions) is added last, as
 * Better Auth requires. A failed start is not cached, so running setup fixes it
 * without restarting the server.
 */
export function getAuthContext() {
  assertNotBuilding();
  if (!globalThis[INSTANCE]) {
    globalThis[INSTANCE] = import('better-auth/next-js')
      .then(({ nextCookies }) => createAuth({ plugins: [nextCookies()] }))
      .catch((err) => {
        delete globalThis[INSTANCE];
        throw err;
      });
  }
  return globalThis[INSTANCE];
}

export function getAuth() {
  return getAuthContext().then((instance) => instance.auth);
}

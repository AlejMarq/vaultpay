// Better Auth options shared by setup (which creates Better Auth's tables) and the app
// (which serves sign-in). Both must use exactly these options so the tables setup
// creates are the tables the app expects.
//
// Plain module, no 'server-only' import: setup scripts run under plain Node.

import { twoFactor } from 'better-auth/plugins';

export { BETTER_AUTH_TABLES } from './db/definitions.js';

export const AUTH_APP_NAME = 'VaultPay';

// `autoSignIn: false` is used only by demo seeding, so creating an account does not also
// create a session. It does not change any table.
export function buildAuthOptions({ database, secret, baseURL, autoSignIn = true }) {
  if (!database) throw new Error('buildAuthOptions: database connection is required');
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('buildAuthOptions: secret must be at least 32 characters');
  return {
    appName: AUTH_APP_NAME,
    baseURL,
    secret,
    database,
    emailAndPassword: { enabled: true, autoSignIn },
    plugins: [twoFactor({ issuer: AUTH_APP_NAME })],
  };
}

// Better Auth options shared by setup (which creates Better Auth's tables) and the app
// (which serves sign-in). Both must use exactly these options so the tables setup
// creates are the tables the app expects.
//
// Plain module, no 'server-only' import: setup scripts run under plain Node.

import { twoFactor } from 'better-auth/plugins';

export { BETTER_AUTH_TABLES } from './db/definitions.js';

export const AUTH_APP_NAME = 'VaultPay';

// Sessions end after 30 minutes without activity (Step 3, decision 5). A session is
// extended at most every 5 minutes, and only inside Server Actions, where the cookie can
// be rewritten together with the database row. The cookie cache stays off, so logout
// and revocation apply to the very next request.
export const SESSION_IDLE_SECONDS = 30 * 60;
export const SESSION_REFRESH_SECONDS = 5 * 60;
export const SESSION_COOKIE = 'better-auth.session_token';
export const TWO_FACTOR_COOKIE = 'better-auth.two_factor';

// MFA marker (Step 3, Section 3C). `session.mfaVerifiedAt` is a column on Better Auth's
// session row, so it belongs to exactly one session:
//   - set only when Better Auth creates a session by completing a second factor (one of
//     the endpoint paths below); every other session starts with null
//   - never accepted from a client (input: false) and never changed afterwards (the
//     update hook drops it), so it cannot be inherited, extended or forged
//   - gone when the session is revoked (logout) or expires
export const MFA_SESSION_PATHS = Object.freeze(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

const sessionHooks = {
  create: {
    before: async (session, ctx) => ({
      data: { ...session, mfaVerifiedAt: MFA_SESSION_PATHS.includes(ctx?.path) ? new Date() : null },
    }),
  },
  update: {
    before: async (data) => {
      const { mfaVerifiedAt: _ignored, ...rest } = data;
      return { data: rest };
    },
  },
};

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
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
      cookieCache: { enabled: false },
      additionalFields: {
        mfaVerifiedAt: { type: 'date', required: false, input: false, returned: true },
      },
    },
    databaseHooks: { session: sessionHooks },
    // Trusted-device bypass is never offered: VaultPay's verify actions never pass
    // trustDevice, and a trusted-device sign-in would create a session without the marker.
    plugins: [twoFactor({ issuer: AUTH_APP_NAME })],
  };
}

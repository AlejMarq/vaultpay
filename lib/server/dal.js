// Data Access Layer: resolves who is making the request. Every protected page and
// Server Action asks this module; nothing here is cached, so logout, revocation, a role
// change or a KYC decision applies to the very next request.
//
// MFA: a valid password session is NOT enough for protected functionality. Protection
// requires `session.mfaVerifiedAt` – a marker Better Auth's session hook sets only on
// sessions created by completing a TOTP or backup-code challenge (lib/server/auth-config.js).
// `twoFactorEnabled` only says TOTP is enrolled; it is never treated as proof that this
// login passed MFA.
//
// Plain module (no next/* imports) so tests can use it directly; lib/server/session.js
// wraps it for pages and Server Actions.

export class AccessDenied extends Error {
  constructor(reason) {
    super(`access denied: ${reason}`);
    this.name = 'AccessDenied';
    this.reason = reason; // 'no-session' | 'mfa-required' | 'wrong-role' | 'inactive'
  }
}

const CLOCK_SKEW_MS = 5000;

// The marker counts only if it is a real timestamp from this session's own lifetime: set
// when the session was created (see auth-config.js), never before it and never in the
// future. Anything else – missing, malformed, copied from another session – is ignored.
function readMfaVerifiedAt(session) {
  const raw = session?.mfaVerifiedAt;
  const value = raw instanceof Date ? raw : typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : null;
  if (!value || Number.isNaN(value.valueOf())) return null;
  const created = new Date(session.createdAt).valueOf();
  if (Number.isNaN(created) || value.valueOf() < created - CLOCK_SKEW_MS || value.valueOf() > Date.now() + CLOCK_SKEW_MS) return null;
  return value;
}

function customerFor(db, userId) {
  const row = db.prepare(`
    SELECT c.customer_id, c.full_name, c.status,
           k.status AS kyc_status,
           w.wallet_id, w.status AS wallet_status
    FROM customer c
    LEFT JOIN customer_current_kyc k ON k.customer_id = c.customer_id
    LEFT JOIN wallet w ON w.customer_id = c.customer_id
    WHERE c.auth_user_id = ?
    ORDER BY w.created_at
    LIMIT 1`).get(userId);
  if (!row) return null;
  return {
    customerId: row.customer_id,
    fullName: row.full_name,
    status: row.status,
    kycStatus: row.kyc_status ?? 'not_started',
    wallet: row.wallet_id ? { walletId: row.wallet_id, status: row.wallet_status } : null,
  };
}

function opsUserFor(db, userId) {
  const row = db.prepare('SELECT ops_user_id, full_name, role, status FROM ops_user WHERE auth_user_id = ?').get(userId);
  return row ? { opsUserId: row.ops_user_id, fullName: row.full_name, role: row.role, status: row.status } : null;
}

/**
 * Resolves the current viewer from request headers (the session cookie), or null.
 * `identityDb` should be a read-only connection. `refresh: true` lets Better Auth extend
 * the session (only where cookies can be written, i.e. inside Server Actions).
 */
export async function resolveViewer({ auth, identityDb, headers, refresh = false }) {
  const result = await auth.api.getSession({ headers, query: refresh ? {} : { disableRefresh: true } });
  if (!result?.session || !result.user) return null;
  const { session, user } = result;

  const customer = customerFor(identityDb, user.id);
  const ops = customer ? null : opsUserFor(identityDb, user.id);
  const mfaVerifiedAt = readMfaVerifiedAt(session);

  return Object.freeze({
    userId: user.id,
    email: user.email,
    name: user.name,
    session: Object.freeze({ id: session.id, expiresAt: new Date(session.expiresAt) }),
    mfa: Object.freeze({
      enrolled: user.twoFactorEnabled === true,
      verifiedAt: mfaVerifiedAt,
      verified: mfaVerifiedAt !== null,
    }),
    kind: customer ? 'customer' : ops ? 'ops' : 'none',
    customer: customer ? Object.freeze(customer) : null,
    ops: ops ? Object.freeze(ops) : null,
  });
}

// Pure checks on a resolved viewer (Section 3D/3E add role- and KYC-specific ones).

/** Any protected functionality: a session that completed MFA during this login. */
export function assertMfaVerified(viewer) {
  if (!viewer) throw new AccessDenied('no-session');
  if (!viewer.mfa.verified) throw new AccessDenied('mfa-required');
  return viewer;
}

/** Where a signed-in user should go next. */
export function landingPath(viewer) {
  if (!viewer) return '/login';
  return viewer.mfa.verified ? '/dashboard' : '/mfa';
}

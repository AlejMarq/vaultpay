// TOTP replay defense around Better Auth's own TOTP check (identity migration 0002).
//
// Better Auth 1.7.10 accepts one TOTP code for several separate sign-in challenges while
// the code is valid. Before a code is handed to Better Auth, it is claimed here:
//   - claim = INSERT on the (user_id, code_hash) primary key – atomic, so of two
//     concurrent attempts with the same code at most one proceeds (also across processes,
//     since SQLite serialises writers)
//   - Better Auth rejects the code → the claim is released (the code was never used).
//     A release removes only the row carrying this claim's random token, and only once,
//     so it can never remove another request's claim on the same code.
//   - Better Auth accepts it → the claim stays until the retention window has passed
// Retention covers Better Auth's acceptance window (current period ± one 30 s period).

import crypto from 'node:crypto';

export const TOTP_CLAIM_RETENTION_MS = 120_000;

const hashCode = (userId, code) => crypto.createHash('sha256').update(`${userId}\u0000${code}`).digest('hex');

/** `db`: a writable identity DB connection. */
export function createTotpReplayGuard(db, { retentionMs = TOTP_CLAIM_RETENTION_MS, now = () => Date.now() } = {}) {
  const purge = db.prepare('DELETE FROM totp_code_use WHERE claimed_at < ?');
  const insert = db.prepare('INSERT INTO totp_code_use (user_id, code_hash, claimed_at, claim_token) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
  const remove = db.prepare('DELETE FROM totp_code_use WHERE user_id = ? AND code_hash = ? AND claim_token = ?');

  return {
    /**
     * Claims `code` for `userId`. Returns { release } if this caller may use the code, or
     * null if the code was already used (or is being verified) for this user.
     */
    claim(userId, code) {
      const t = now();
      const h = hashCode(userId, code);
      const token = crypto.randomBytes(16).toString('hex');
      const claimed = db.transaction(() => {
        purge.run(t - retentionMs);
        return insert.run(userId, h, t, token).changes === 1;
      }).immediate();
      if (!claimed) return null;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          remove.run(userId, h, token);
        },
      };
    },
  };
}

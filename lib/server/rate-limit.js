// Small, bounded, in-memory login rate limiter (Step 3, decision 2 – Better Auth's own
// limiter only covers its HTTP routes, which VaultPay does not mount).
//
// Only failed attempts count. Three sliding windows apply at once:
//   client + email – repeated guesses at one account from one client
//   email          – one account, from any client (so a changed client key does not help)
//   client         – many accounts from one client (password spraying)
// Unknown emails are limited exactly like real ones, so the limiter reveals nothing.
// Memory is bounded: expired keys are swept, and the oldest keys are dropped at the cap.
//
// Client key: the server listens on 127.0.0.1 only and has no reverse proxy, so every
// genuine client is local. Forwarded headers are set by the client itself (Next.js only
// fills X-Forwarded-For when it is absent), so they are never used to tell clients apart:
// a loopback value maps to "loopback"; anything else – missing, malformed, a list, a
// non-loopback address – maps to the shared "unverified" key.

import net from 'node:net';

export const DEFAULT_LIMITS = Object.freeze({
  windowMs: 15 * 60 * 1000,
  perClientEmail: 5,
  perEmail: 10,
  perClient: 30,
  maxKeys: 5000,
});

const MAX_EMAIL_LENGTH = 254;

export const rateLimitedMessageFor = (seconds) =>
  `Too many attempts. Try again in ${Math.max(1, Math.ceil(seconds / 60))} minute(s).`;

/** Lower-case, trimmed, NFKC-normalized email, or null if it cannot be an email. */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.normalize('NFKC').trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null;
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  return email;
}

function isLoopback(ip) {
  if (net.isIPv4(ip)) return ip.startsWith('127.');
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || (lower.startsWith('::ffff:') && net.isIPv4(lower.slice(7)) && lower.slice(7).startsWith('127.'));
  }
  return false;
}

/** Maps request headers to a client key: "loopback" or "unverified" (see above). */
export function clientKey(headers) {
  const raw = headers?.get?.('x-forwarded-for');
  if (typeof raw !== 'string') return 'unverified';
  const value = raw.trim();
  if (value.includes(',') || !isLoopback(value)) return 'unverified';
  return 'loopback';
}

export function createLoginRateLimiter(limits = {}, now = () => Date.now()) {
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  const failures = new Map(); // key → array of failure timestamps (oldest first)

  const recent = (key, t) => {
    const list = failures.get(key);
    if (!list) return [];
    while (list.length && list[0] <= t - cfg.windowMs) list.shift();
    if (list.length === 0) failures.delete(key);
    return list;
  };

  // subject is the normalized email for logins, the user id for MFA checks.
  const keysFor = (client, subject) => [
    { key: `ce:${client}|${subject ?? '-'}`, limit: cfg.perClientEmail },
    { key: `e:${subject ?? '-'}`, limit: cfg.perEmail },
    { key: `c:${client}`, limit: cfg.perClient },
  ];

  function sweep(t) {
    for (const key of failures.keys()) recent(key, t);
    while (failures.size > cfg.maxKeys) failures.delete(failures.keys().next().value);
  }

  return {
    /** { allowed, retryAfterSeconds } – call before attempting a login. */
    check(client, subject) {
      const t = now();
      let retryAfter = 0;
      for (const { key, limit } of keysFor(client, subject)) {
        const list = recent(key, t);
        if (list.length >= limit) retryAfter = Math.max(retryAfter, list[list.length - limit] + cfg.windowMs - t);
      }
      return { allowed: retryAfter === 0, retryAfterSeconds: Math.ceil(retryAfter / 1000) };
    },
    recordFailure(client, subject) {
      const t = now();
      for (const { key, limit } of keysFor(client, subject)) {
        const list = recent(key, t);
        list.push(t);
        if (list.length > limit) list.splice(0, list.length - limit); // never store more than needed
        failures.delete(key);
        failures.set(key, list); // re-insert: Map order = least recently failed first
      }
      if (failures.size > cfg.maxKeys) sweep(t);
    },
    /** A successful login clears that client's and that account's failures. */
    recordSuccess(client, subject) {
      failures.delete(`ce:${client}|${subject}`);
      failures.delete(`e:${subject}`);
    },
    get size() {
      return failures.size;
    },
  };
}

// Second-factor checks (enrollment confirmation and sign-in challenges), keyed by user id.
// Works alongside Better Auth's own limits: 5 attempts per sign-in challenge and a
// 15-minute account lock after 10 consecutive failures.
export const MFA_LIMITS = Object.freeze({ windowMs: 15 * 60 * 1000, perClientEmail: 5, perEmail: 8, perClient: 30, maxKeys: 5000 });

export function createMfaRateLimiter(now) {
  return createLoginRateLimiter(MFA_LIMITS, now);
}

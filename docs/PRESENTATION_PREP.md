# VaultPay – Presentation Preparation

Notes for the live demonstration / presentation of Project 2. Every statement points to code
or a test you can open during the presentation. Suggested order: architecture (3 min) →
live demo (8 min) → threats and code (8 min) → AI pair programming (4 min).

## 1. The system in one picture

```
Browser ──HTTP 127.0.0.1:3000──► Next.js (customer app + read-only support/operations views)
                                   │ mTLS + single-use tokens
             ┌─────────────────────┴───────────────┐
             ▼                                     ▼
   Identity (4200) ── signs tokens ──►  CBI (4300) ── mTLS + credential ──► mock Core Banking (4100)
             ▲                                     ▲
   Settlement (4500) ◄── settlement worker         │
   Fraud & Risk (4400) ◄── fraud worker            │
                         reconciliation ───────────┘ (read-only lookups)
```

Say it like this:

- **Next.js holds no secrets** that could move money: no token signing key, no bank
  credential, no other service's certificate. It only reads with read-only connections and
  writes transfers through one narrow writer.
- **Identity** is the only token issuer; each endpoint serves exactly one caller certificate and
  one purpose. Callers never choose a scope, audience, account or amount.
- **CBI** is the only way to the bank and the only holder of the bank credential. A posting
  request has no body: the bank details come only from the signed token.
- **Fraud & Risk** is the only holder of the decision signing key. **Settlement** re-verifies
  the signed approval. **Reconciliation** compares VaultPay's records with the bank's.
- Every connection between processes is **mutual TLS** with exact identities on both sides.
- Three SQLite databases (identity, transaction, mock bank), each opened only by its owners.

Where to show it: `README.md` (system summary, Assignment 5 table), `docs/SERVICE_AUTH.md`
section 1–2 (credentials per process).

## 2. End-to-end transfer workflow (what happens, where)

| # | Step | Code |
|---|------|------|
| 1 | Sign in: password, then TOTP; session gets an MFA marker set only by the server | `app/login/actions.js`, `lib/server/login.js`, `lib/server/mfa.js`, `lib/server/auth-config.js` (session hook), `lib/server/dal.js` → `readMfaVerifiedAt`, `assertMfaVerified` |
| 2 | `/send` review → confirm (Server Action, same-origin check first) | `app/send/actions.js` → `transferAction`; `lib/server/origin.js` → `assertSameOrigin` |
| 3 | Server re-checks: MFA, active customer, approved KYC, own active wallet, recipient, amount in integer cents, per-account rate limit, preliminary balance via Identity → CBI | `lib/server/transfer-initiation.js` → `initiateTransfer`; `lib/server/eligibility.js`; `lib/server/money.js` → `parseUsdToCents`; `lib/server/rate-limit.js` → `createTransferRateLimiter`; `lib/server/balance.js` |
| 4 | One DB transaction: transfer `pending_risk` + audit event + `fraud_check` outbox message; idempotency key per sender; backlog limits | `lib/server/transfer-orchestrator.js` → `createTransferWriter` → `create` |
| 5 | Fraud worker leases the message, sends the DB row to Fraud & Risk, verifies the signed decision, applies it in one transaction | `lib/orchestrator/fraud-worker.js`; `services/fraud/app.js`; `lib/fraud/engine.js`; `lib/fraud/risk-decision.js` |
| 6 | Settlement worker re-verifies the approval, records the attempt **before** sending, Settlement gets a one-posting token from Identity, CBI posts at the bank | `lib/orchestrator/settlement-worker.js`; `services/settlement/app.js`; `services/identity/app.js` → `settlementToken`; `services/cbi/app.js` → `posting` |
| 7 | Bank: idempotency key first, then active accounts and funds, then debit + credit + posting in one transaction | `services/mock-core-banking/app.js` (`post`) |
| 8 | Worker: `completed` + one ledger debit and one credit with the bank's posting reference (DB triggers enforce double entry) | `settlement-worker.js` → `complete`; `lib/server/db/migrations/transaction/0005_settlement.sql` |
| 9 | Reconciliation: resolves lost answers with the same key, compares finished transfers with the bank, expires overdue ones, checks the ledger | `lib/orchestrator/reconciliation.js`; `services/orchestrator/reconcile.js` |
| 10 | Support sees a read-only, audited overview | `app/operations/page.js`; `lib/server/operations.js` |

Live demo script with expected results: `docs/DEMO_CHECKLIST.md`.

## 3. Assignment 4 threats → controls (short version)

Full table with files, functions and tests: `README.md` → *Threat-to-control mapping*.

| Threat | One-sentence answer | Show |
|--------|---------------------|------|
| 121 flood (Critical) | Per-account limit on transfer confirmations, pending-backlog limits in the write transaction, DB idempotency | `rate-limit.js` `createTransferRateLimiter`; `transfer-orchestrator.js` `MAX_PENDING_*`; HTTP check "Transfer flood" |
| 272 fraud outage (Critical) | Transfers wait in `pending_risk`; never approved by default; backoff, parking, expiry | `fraud-worker.js` `retry`; test "Fraud & Risk unavailable" |
| 287 settlement outage (Critical) | Waits and retries with the same bank key | `settlement-worker.js`; test "Settlement or CBI unavailable" |
| 282 interrupted settlement | Attempt recorded before sending; bank idempotency; reconciliation with the same key | mock bank `post`; test "bank timeout AFTER posting" |
| 307 interrupted DB write | Transactional outbox: all-or-nothing writes | `transfer-orchestrator.js` `create`; test "database errors: nothing is half-written" |
| 220 / 274 / 289 code execution via input/responses | Strict schemas on every request and response, no body for postings, no eval | `services/cbi/app.js`, `risk-decision.js` `DecisionClaims`, `settlement/app.js` |
| 280 / 85 spoofed adapter / bank | mTLS with exact expected server CN; certificate-bound tokens | `mtls-request.js` `expectedServer`; `pki.test.mjs` threat 280 test |
| 305 spoofed DB | Safe open: application id, role, schema fingerprint, no links | `lib/server/db/open.js`; `open.test.mjs` |
| 120 tampered records | Server-derived sender, narrow writer, append-only + state-machine triggers | `0001_initial.sql` triggers; `transaction-schema.test.mjs` |
| 284 tampered settlement result | Reconciliation compares every finished transfer with the bank; mismatches flagged | `reconciliation.js` `verifyFinished`; test "threat 284: a tampered settlement result is detected" |
| 82 manipulated screening | Ed25519-signed, bound, expiring decisions; verified by worker, Settlement and Identity | `risk-decision.js`; fraud tests "tampered, replayed…" |
| 244 ops portal | Support read-only end to end, audited before data, no actions | `support.js`, `operations.js`; "support has no write path" |

## 4. Security-sensitive code worth explaining (and why it is correct)

1. **MFA marker** – `lib/server/auth-config.js` (session `create.before` hook) sets
   `mfaVerifiedAt` only when Better Auth creates the session from a completed TOTP/backup-code
   challenge; `lib/server/dal.js` → `readMfaVerifiedAt` accepts it only within that session's
   lifetime. A password-only session never reaches protected pages (`tests/app/roles.test.mjs`).
2. **Same-origin + Host check** – `lib/server/origin.js` → `assertSameOrigin` is the first
   statement of every Server Action (static test `security-invariants.test.mjs`); it refuses a
   missing Origin and any non-localhost Host (DNS rebinding).
3. **Transfer writer** – `transfer-orchestrator.js` `create`: idempotency lookup, backlog
   limits and funds check run inside `BEGIN IMMEDIATE`, so two concurrent requests cannot both
   pass; transfer, audit and outbox commit together.
4. **Signed decisions** – `risk-decision.js` `verifyRiskDecision`: algorithm pinned to EdDSA,
   `typ` and `kid` checked, strict claims, binding compared field by field with the DB row,
   request id compared, expiry enforced.
5. **Leases and fencing** – `fraud-worker.js` / `settlement-worker.js`: the `attempts` value of
   a claim is a fencing token; every write requires it, so a worker that lost its lease cannot
   change anything (tests "a stale worker cannot apply after losing its lease").
6. **Bank idempotency** – mock bank `post`: an existing posting for the key is returned (or
   409 on a different payload) before any funds check, so a retry never moves money twice.
7. **Never guess an outcome** – `settlement-worker.js` marks a transfer `failed` only for a
   first-and-only send; reconciliation never fails a transfer because a posting is missing
   (D76/D77 – explained below).
8. **Purpose-specific tokens** – `services/identity/app.js`: three endpoints, one caller
   each; `services/cbi/app.js` checks scope per caller and route; tokens are single use.

## 5. AI pair programming – how it was used, and real mistakes caught

How we worked: for each step I gave requirements and security constraints; the AI inspected
the code, proposed or implemented the design, ran all test commands, and stopped for my
approval. I approved, questioned, corrected or rejected (`docs/PAIR_PROGRAMMING_LOG.md`
section 1, "My response"). Commits happened only when I asked.

My corrections that changed the design:

- **Signing key in Next.js (D43):** the AI first placed the service-token signing key inside
  the Next.js process. I required a separate Identity process as the only key holder.
- **Generic token endpoint (D44, D62):** I required purpose-specific endpoints where callers
  cannot choose accounts, scopes or amounts.
- **MFA "enrolled" vs "completed" (Step 3):** I required that a session counts as MFA only if
  this login completed the second factor – not merely because TOTP is enrolled.
- **Ambiguous settlements (D76):** I required "keep it unresolved" when an outcome cannot be
  proven.

Defects found by testing and review, then fixed (log section 3):

| Problem | How it was caught | Fix |
|---------|-------------------|-----|
| DNS rebinding: a malicious site resolving to 127.0.0.1 could send "same-origin" Server Actions | 3F security review; HTTP test with a foreign Host | Localhost Host allowlist in every action, session lookup and `/api/health` |
| Better Auth accepted the same TOTP code for enrollment and two sign-ins | Step 3D testing (log, Problems) | Replay guard with atomic claims (`totp-replay.js`) |
| A failed attempt's claim release could delete another request's claim | Step 3E review; regression test fails on the old code | Random claim token + one-shot release (identity migration 0003) |
| Next.js accepts Server Actions with **no** Origin header | Step 3B HTTP checks | `assertSameOrigin` refuses missing Origin |
| Build output tracing listed `data/` (private keys, `.env`) | Step 3A, inspecting the build output | `turbopackIgnore` + HTTP check fails on any traced secret |
| `next build` opened the real database | Step 3C | Request read first; DB getters refuse to run during build |
| Backup codes lost after enrollment (Next re-rendered with the old cookie) | Step 3C | DAL reads `cookies()` |
| Reconciliation marked transfers `failed` when "no posting found" – a late bank commit could debit a failed transfer | Step 9 review of the exact conditions | Never fail on absence; regression test races a late posting (D76); same race for refusals after an unanswered send (D77) |
| Final compliance review against my Assignment 4/5 documents: no per-account rate limit on the transfer route (threat 121) and no comparison of finished transfers with the bank (threat 284) | Comparing the code with the original submissions | Transfer rate limiter + backlog limits; `verifyFinished` in reconciliation; tests for both |
| Flaky settlement tests (2 of ~15 runs) | Repeated full runs | Realistic 3 s deadline in the harness; recovery steps assert end state |
| `/operations` audited twice per page load (Next renders twice) | HTTP check counted audit rows | One record per session within 2 s |
| `npm ci` on a fresh copy tried to compile `better-sqlite3` | Testing the ZIP in a clean folder | Documented `npm ci --ignore-scripts` |

Lessons to state: generated code can look right and be wrong under concurrency or
unusual inputs; every control needed a test that fails without it; reviewing against the
original threat model found gaps that feature testing did not.

## 6. Questions to be ready for

- *Why not mark a transfer failed when the bank says "not found"?* Because the request could
  still be inside the bank; failing it could leave money moved without a ledger entry. The
  funds stay reserved until the posting appears or a person resolves it.
- *What stops a compromised Next.js from moving money?* It has no signing key and no bank
  credential; Identity issues settlement tokens only to Settlement's certificate and only for
  a transfer Fraud & Risk approved.
- *What if two workers process the same message?* Database leases plus fencing tokens; the
  bank's idempotency key protects the last step.
- *Why SQLite triggers instead of database roles?* SQLite has no users or roles; read-only
  connections, narrow module APIs and triggers are the closest equivalent (D3) – a documented
  deviation.

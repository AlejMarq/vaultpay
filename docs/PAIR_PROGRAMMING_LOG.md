# VaultPay – AI Pair-Programming Log

Project 2, Secure Software Development — Alejandro Marquez
AI pair programmer: Claude

This log records what the AI recommended, what I accepted, questioned, changed or
rejected, problems we hit, and security tests run. The README's "Deviations from
Assignment 5" and "Known limitations" sections are built from it.

---

## 1. Decisions

| # | Date | Topic | AI recommendation | My response | Final decision |
|---|------|-------|-------------------|-------------|----------------|
| D1 | 2026-10-13 | Process layout | Six processes (Next.js, Fraud, Settlement, Core Banking Integration, outbox worker, mock partners) | **Questioned** – asked for a security or functional reason for each process | Five processes. Outbox worker moved into Next.js (no security reason to be separate). Each remaining process is justified by specific threats (see D1 notes). |
| D2 | 2026-10-13 | Authentication | Custom sessions + hand-built TOTP MFA | **Questioned** – preferred an established library; asked for a comparison | Better Auth (email/password + two-factor plugin). Auth.js is now maintained by the Better Auth team, who recommend Better Auth for new projects; Auth.js would still have needed hand-built MFA. Approval conditional on verifying version compatibility and correct MFA enforcement. |
| D3 | 2026-10-13 | SQLite permissions | Per-connection "role" function + triggers to limit which component inserts ledger rows | **Questioned** – asked what it really protects | **Dropped.** It's a guard rail against our own code, not a boundary (a compromised process can register the same function; file access bypasses triggers). Kept: read-only connections (SQLite-enforced), append-only ledger triggers, and Fraud/Settlement not opening the database at all. |
| D4 | 2026-10-13 | Threat 305 | HMAC-signed database identity marker | **Questioned** – asked what an attacker needs to bypass it | **Replaced.** The signed marker can be defeated by copying the row into a fake database. Using: path must resolve inside `data/`, no symlinks, file must already exist, `db_meta` role + schema version check, fail closed. |
| D5 | 2026-10-13 | Expiring pending transfers | Expire after a maximum pending window | Approved with AI's correction | Never auto-expire a transfer once a settlement request may have been sent; "settlement attempted" is recorded before the request leaves. |
| D6 | 2026-10-13 | Language | First TypeScript, then revised to JavaScript | **Accepted** JavaScript | JavaScript ES modules. Runtime safety comes from Zod validation, not types. |
| D7 | 2026-10-14 | Balances | Actual = Core Banking balance; available = actual − holds for transfers Core Banking cannot have processed yet; hold "sent, outcome unknown" transfers conservatively | **Accepted with change** – don't claim available balance is always accurate during an unknown outcome | Available balance is documented as an estimate during an unknown settlement outcome. Core Banking remains the system of record and performs the final funds check. |
| D8 | 2026-10-14 | Outbox worker leasing | Reuse `next_attempt_at` as the lease | **Changed** – wants separate fields for clarity | `OutboxMessage` gets `next_attempt_at` **and** `lease_until`. |
| D9 | 2026-10-14 | Certificates | `selfsigned` 5.x (pure JS, devDependency, setup-time only); one dev CA, peer name checks, Core Banking Integration permissions derived from client certificate | **Accepted, conditional** on verifying the library works | `selfsigned` 5.5.0 verified on the home PC (smoke test section 5: 8/8 pass, 2026-10-18). Used by `npm run setup` (Step 2); scope narrowed by D19. Work laptop pending. |
| D10 | 2026-10-14 | Service tokens | Ed25519 tokens using Node's built-in crypto, fixed format, strict validation (iss, aud, scope, transfer_id, iat/exp ≤ 60 s) | **Accepted**; asked for a brief comparison with `jose` before implementing auth | **Original proposal (accepted 2026-10-14):** Node built-in crypto. **Later AI recommendation:** use `jose` (`EdDSA`, with strict `algorithms` / `issuer` / `audience` / `maxTokenAge` / `requiredClaims` checks), verified by the Phase 0 smoke test (7/7). **Changed 2026-10-18 – I approved `jose`** for signed service tokens and signed risk decisions. Ed25519 keys and the fixed claim set are unchanged; `risk_decision.signature` stores the compact JWS. |
| D11 | 2026-10-14 | Packaging | `git archive` + secret scan of the ZIP | **Accepted** | Applies at final packaging. |
| D12 | 2026-10-14 | Two-computer workflow | — | **My requirement** – work laptop + home PC synced through a private GitHub repo, project at `C:\dev\vaultpay` on both | Single `main` branch; pull before starting, push before leaving; each computer generates its own certificates, secrets and databases with `npm ci` + `npm run setup`; nothing machine-specific is committed. |
| D13 | 2026-10-18 | Node.js version | — | **My requirement** – both computers use the same Node.js version | Node.js 22 pinned: `.nvmrc` = `22.23.3`, `package.json` `engines.node` = `>=22.0.0 <23.0.0` (commit 7644763). Home PC verified on Node 22.23.3 / npm 10.9.9. |
| D14 | 2026-10-18 | Step 2 database layer (Section A) | STRICT tables; versioned SQL migrations with SHA-256 checksums; safe open that fails closed (path inside `data/db`, no links/junctions/hard links, `quick_check`, `application_id` + `db_meta` role, exact schema version, full schema comparison against the migrations); business rules enforced by triggers | **Accepted** | Implemented in `lib/server/db/`. The schema comparison catches dropped, replaced or added triggers/tables/indexes. Like D3/D4 this guards against mistakes, not against someone with write access to `data/`. |
| D15 | 2026-10-18 | Module format | Add `"type": "module"` to `package.json` (AI made the change, then asked) | **Approved** | Plain Node scripts import `lib/` without warnings; matches D6. Lint, build, smoke test and `/api/health` verified afterwards. |
| D16 | 2026-10-18 | Amount ceiling | Database-level ceiling of $10,000 (1,000,000 cents) on transfers, ledger entries and postings | **Approved for the demo** – must stay separate from the configurable business transfer limit | DB `CHECK` is a sanity limit only; the business limit will be configuration, enforced in application code. |
| D17 | 2026-10-18 | Better Auth table order | VaultPay migrations first, then Better Auth migrations; `customer`/`ops_user` reference Better Auth's `user` table | **Approved** – setup must verify all five Better Auth tables | Setup runs Better Auth's `getMigrations`; `setup:check` requires `user`, `session`, `account`, `verification`, `twoFactor` with expected columns/indexes. |
| D18 | 2026-10-18 | Audit event types | Format-check `audit_event.event_type` until event types are designed | **Approved** | Lower-case/dot/underscore format only; list to be fixed by a later migration. |
| D19 | 2026-10-18 | mTLS scope | Certificates for every internal link | **Changed** – prioritize the required Core Banking links; others if time permits | Certificates for CBI, Settlement, Reconciliation (read-only client) and mock Core Banking. Fraud, mock fraud scoring and Next.js → Fraud/Settlement links: not yet. |
| D20 | 2026-10-18 | Demo MFA | Seed without TOTP vs. pre-enrol TOTP secrets in a file | **Approved**: users enrol TOTP on first sign-in | No demo account has 2FA after seeding; enforcement and enrolment UI in Step 3. |
| D21 | 2026-10-18 | Demo passwords | Fixed, documented demo-only passwords | **Approved** – must be clearly marked as never for real accounts, never exposed beyond localhost | Passwords in `docs/SETUP.md` and `scripts/setup/demo-data.mjs`, with warnings in both and in the README. Setup refuses to run with `NODE_ENV=production`. |
| D22 | 2026-10-18 | Repeatable setup (Section B) | Create missing items only; secrets and certificates as complete sets (partial set = stop); replacing anything needs a flag **and** a typed confirmation; old items moved to `data/backups/`, never deleted; lock file; older DB schema backed up before migrating | **Accepted**; reset/rotation lower priority than fresh + repeat setup | `npm run setup`, `npm run setup:check`. Flags `--reset-db` / `--rotate-secrets` / `--renew-certs` implemented. |
| D23 | 2026-10-18 | File permissions | Best-effort `icacls` on `data/pki` and `data/secrets`; report failures | **Approved** | Applied to all of `data/` (the identity DB holds password hashes and TOTP secrets): inheritance removed, current user only. Failures surface as `WARN`. Not protection against administrators or malware running as the user. |
| D24 | 2026-10-18 | Demo balances | Separate mock Core Banking database | **Approved** – Core Banking remains the source of truth (D7). Alice $500, Bob $250; AI to choose Carol and merchant | `data/db/mock-core-banking.db`: Carol $100.00 (funded but KYC pending, to demonstrate the KYC block), Demo Coffee $0.00 (receives only). Balances seeded once, never reset by setup; append-only `posting` table with unique idempotency key for later settlement. |
| D25 | 2026-10-18 | Demo seeding (Section C) | Seed through Better Auth's sign-up API; fixed demo IDs; create only what is missing; stop on conflicting existing data | **Accepted** | Alice/Bob/Carol customers + wallets, support ops user, Demo Coffee. Seeding disables Better Auth's auto sign-in (no sessions created) and waits for Better Auth's schema check before closing the database. |

| D26 | 2026-10-18 | Auth transport (Step 3) | Server Actions calling `auth.api` only; no public `/api/auth/*` routes | **Approved, conditional** on Better Auth's login, cookie, TOTP-challenge and backup-code flows working that way | Verified with Better Auth 1.7.10 (direct API probe, then real Server Action POSTs). Finding: direct `auth.api` calls skip Better Auth's Origin check, so CSRF protection is VaultPay's (D31). No self-registration. |
| D27 | 2026-10-18 | Network exposure | `next dev`/`next start` listen on all interfaces by default | **Changed** – localhost only | `--hostname 127.0.0.1`; LAN addresses refuse connections (tested). 3F added a localhost `Host` allowlist against DNS rebinding (Problems, 2026-10-19). |
| D28 | 2026-10-18 | Sessions | 30 min idle, refresh ≤ every 5 min, cookie cache off | **Approved** | Page renders read sessions without extending them; only Server Actions (incl. a throttled keep-alive) extend, so cookie and database row change together. Logout revokes the row. |
| D29 | 2026-10-18 | Login rate limiting | Small bounded in-memory limiter keyed by client and normalized email | **Approved** – must not trust client-supplied forwarded headers | Windows of 5 (client+email) / 10 (email) / 30 (client) failures per 15 min; forwarded headers map only to `loopback` or a shared `unverified` key; unknown emails limited the same way; bounded at 5,000 keys. |
| D30 | 2026-10-18 | MFA proof | Use `twoFactorEnabled` | **Changed** – the *current session* must have completed MFA | `session.mfaVerifiedAt`, set by Better Auth's session-create hook only for `/two-factor/verify-totp` and `/two-factor/verify-backup-code`; `input: false`; stripped from updates; DAL accepts it only within the session's own lifetime. |
| D31 | 2026-10-18 | CSRF | Rely on Next.js's Server Action Origin check | **Changed** | Next lets a POST with *no* Origin through; every Server Action also calls `assertSameOrigin` (Origin present and equal to Host, Host localhost). Static test enforces it for all actions. |
| D32 | 2026-10-18 | TOTP enrollment UX | `qrcode` 1.5.4 (exact) for the QR code; show backup codes once; no trusted-device option | **Approved** | QR + manual key after password re-entry; enrollment completes only after the first code; backup codes fetched with `viewBackupCodes` after verification and returned in that one response. |
| D33 | 2026-10-19 | TOTP replay | Test whether Better Auth accepts a code twice; add a minimal defense if so | **My requirement** | Better Auth 1.7.10 accepted one code for enrollment and two further challenges. VaultPay claims each code (hashed, per user, atomic primary key) before Better Auth checks it; releases only its own claim (random token, once). Identity migrations 0002–0003. |
| D34 | 2026-10-19 | Role access | `requireCustomer()` / `requireSupport()` server-side guards, both requiring MFA | **Approved** | Active customer / active `support_readonly` ops user; suspended, closed, disabled and role-less accounts → `/access-denied`; checked in every page and action and again in the data functions; nothing cached. |
| D35 | 2026-10-19 | Support access and audit | Read-only support lookup; separate narrowly scoped append-only audit writer | **My requirement** – support connections must stay read-only | Support reads via read-only connections, masked contact data; `lib/server/audit.js` exposes one INSERT; transaction migration 0002 registers `support.customer_search` / `support.customer_view` and rejects other types; audit written before data is shown (fail closed). |
| D36 | 2026-10-19 | KYC eligibility | Reusable `requireVerifiedCustomer()` for sending money | **My requirement** – re-checked by Step 5 immediately before creating a transfer | `lib/server/eligibility.js` reads customer, wallet and latest KYC from the database at call time (never the request-start snapshot); `/send` placeholder explains refusals. |
| D37 | 2026-10-19 | Balances in the UI | – | **My requirement** – no direct mock Core Banking reads from Next.js | `/wallet` shows a "available after CBI" message; a test fails if app code opens the mock bank DB. |
| D38 | 2026-10-18 | Build hygiene | – | (AI finding, accepted) | Runtime `data/` paths marked `turbopackIgnore` so build traces never list databases/keys/secrets (regression check in `test:http`); the DB/Better Auth getters refuse to run during `next build`. |

| D39 | 2026-10-19 | Mock Core Banking service (Step 4A) | Separate Node.js HTTPS process on 127.0.0.1, read-only balance endpoint, reusing the Step 2 certificates and env files | **My requirement** – no `rejectUnauthorized: false`, generic errors, no DB exposure to Next.js | `services/mock-core-banking/`; owns the only connection to `mock-core-banking.db` (read-only); `npm run mock-bank`, `npm run test:mock-bank`. |
| D40 | 2026-10-19 | Who may call Core Banking | Any client certificate from the dev CA | **Changed (AI)** – CA trust alone would let Settlement or Reconciliation reach the bank | The bank also requires `CN=vaultpay-cbi` and the Core Banking credential from `cbi.env` (constant-time compare), checked before the request is parsed. |
| D41 | 2026-10-19 | CBI → bank client | Narrow client: one read-only call, mTLS with CBI's certificate, server identity pinned to `CN=vaultpay-mock-core-banking`, 3 s hard deadline, 16 KB limit, strict zod schema | **My requirement** – explicit timeouts | `lib/cbi/core-banking-client.js`; for the CBI process only (a test fails if `app/` or `lib/server/` import it). |
| D42 | 2026-10-19 | Service tokens (design for 4B) | Identity-issued EdDSA JWS, `typ vaultpay-service+jwt`, `kid`, `iss vaultpay-identity`, single `aud`, `sub` = mTLS CN, `cnf.x5t#S256` certificate binding, ≤ 60 s, single-use `jti`, one scope + request binding | **My requirement** – design only, not a broad framework | `docs/SERVICE_AUTH.md`; to be implemented on the links into CBI in Step 4B. |

| D43 | 2026-10-19 | Who holds the service-token signing key | Identity inside the Next.js process (`web.env`, D42 design) | **Changed – my security correction**: Next.js must not hold or use it | New **Identity service process** (`services/identity/`, `identity.env`) is the only holder; Next.js refuses to start if `web.env` contains it (or any other process's secret). |
| D44 | 2026-10-19 | How Next.js gets a balance token | Next.js requests a token for an account | **Changed (AI, within my requirement: no generic endpoint, no caller-chosen account)** | One purpose-specific endpoint: Next.js presents the **customer's own session token** over mTLS; Identity validates session, MFA marker, active customer and active wallet in its read-only DB and takes the account from the wallet record. Fixed `aud`/`sub`/`scope`; 30 s; `cnf` binding; single-use `jti`. |
| D45 | 2026-10-19 | Next.js's service identity | Reuse the Reconciliation certificate | **Changed (AI)** | Separate client certificate `vaultpay-web` for Identity and CBI calls; `vaultpay-recon` stays for reconciliation. Identity gets a server certificate `vaultpay-identity`. |
| D46 | 2026-10-19 | Upgrading existing installations | `--rotate-secrets` / `--renew-certs` | **Changed (AI)** – rotation would break TOTP enrollments | `npm run setup` moves the signing key unchanged from `web.env` to `identity.env` (backup kept) and issues only the *new* certificates from the existing CA; a half-present certificate is still refused. Verified on the home PC (same key id, same Better Auth secret). |

### D1 notes – why each process exists
- **Next.js app** – required stack; hosts UI, API routes, Identity, Orchestrator & Ledger (+ background loop), Ops Support, Reconciliation & Audit.
- **Fraud & Risk Check** – real outage for 272; sole holder of the signing key for 82; hostile scoring responses for 274.
- **Settlement** – real outage for 287; independent signature verification for 82; hostile responses for 289.
- **Core Banking Integration** – 280 requires a real connection to spoof; isolates core-banking credentials; contains 220.
- **Mock partners** (simulated Core Banking + fraud scoring) – external systems needed to test 85, 282, 274, 284.

---

## 2. Deviations from Assignment 5 (for the README)

| Assignment 5 says | Implementation | Why |
|---|---|---|
| Each pipeline stage and the Orchestrator run as separate services | Orchestrator & Ledger runs inside the Next.js app; Fraud, Settlement and Core Banking Integration are separate processes | Fewer processes; separation kept where a prioritized threat depends on it (D1) |
| Ops Portal is a separate Next.js deployment | Same Next.js app, separate route tree and role checks | One app for an installer to run |
| Auth.js sessions | Better Auth (adds its own tables to the Customer & Identity DB) | D2 |
| SSO with MFA for ops staff | Better Auth login + TOTP; role from `OpsUser` | No identity provider available locally |
| Per-service least-privilege database roles | Read-only connections, append-only triggers, only Orchestrator and Reconciliation & Audit write the Transaction DB | SQLite has no users or roles (D3) |
| Fraud & Risk Check and Settlement write their own records | They are stateless; the Orchestrator stores their results | Closest SQLite equivalent of least privilege (D3) |
| Transaction DB reached over verified TLS to a private endpoint (305) | Path / existence / identity checks | SQLite is an embedded file with no network connection (D4) |
| KMS / Vault | Per-process environment files generated by setup | Not available locally |
| WAF + rate limiter backed by a shared store | Input validation, size limits, security headers; in-memory rate limiter | Single local instance; not equivalent to a WAF |
| `decimal` money columns | Integer cents | SQLite has no decimal type |
| `idempotency_key` globally unique | Unique per sender | Stops one user blocking another's key |
| `OutboxMessage` fields | Adds `lease_until` | D8 |
| `KycVerification` row per customer | Append-only `kyc_verification` history; current status = newest row (`customer_current_kyc` view) | Keeps every KYC decision; no row is ever overwritten |
| `OpsUser.sso_subject` | `ops_user.auth_user_id` → Better Auth `user.id` | No SSO provider locally (see "SSO with MFA" above) |
| `RiskDecision.risk_score` decimal | Integer 0–1000 | SQLite has no decimal type; avoids floating-point scores |
| `LedgerEntry.wallet_id` | `account_type` (wallet / merchant) + `account_id` | Merchant payments need a credit entry for the merchant |
| `SettlementRecord` | `settlement_attempt`, adds `attempt_no`, `idempotency_key` (sent to Core Banking) and `requested_at` (written before the request leaves) | D5; idempotent retries for 282 |
| `Transfer.status` enum (unspecified) | `pending_risk → pending_settlement → settlement_in_flight → completed / failed`, plus `declined`, `expired`; transitions enforced by trigger | D5 enforced in the database: no expiry or re-screening once settlement was attempted |
| Mock Core Banking balances | Separate mock Core Banking database (Step 2, later section) | D7 – Core Banking stays the source of truth for balances |
| Auth.js sessions as Next.js Middleware on every request | Better Auth through Server Actions; Next.js 16 `proxy.js` only redirects when no cookie is present; all authorization in the server-side DAL | Next.js 16 renamed Middleware to Proxy and documents it as unsuitable for authorization (D26) |
| Ops Support reports access to Reconciliation & Audit, which writes the audit event | A separate append-only audit writer inside the Next.js process (own connection, one INSERT) | Reconciliation & Audit runs inside Next.js (D1); separation is by connection and API, not process (D35) |
| Money-moving routes require "MFA or step-up" | Every protected page requires that the *current session* completed TOTP or a backup code; no step-up yet | Simpler and stricter for the demo (D30) |

---

## 3. Problems and resolutions

| Date | Problem | Resolution |
|------|---------|------------|
| 2026-10-14 | The AI's workspace cannot reach the npm registry (blocked by policy), so it can't install or run the app's packages | All installs and runtime tests run on my Windows machines; the AI checks built-in-only code before handing it over |
| 2026-10-18 | AI's first draft of the smoke test read the server certificate after the HTTPS response ended; the socket is released by then, so it crashed. Caught when the AI ran the mTLS section against OpenSSL-made certificates before handing it over | Read the peer certificate when the response starts; use a fresh connection per check (`agent: false`) |
| 2026-10-14 | `npm audit` (full) reports 5 high-severity findings in the ESLint dependency chain (`braces`); no non-breaking fix offered | Did not run `npm audit fix --force`. Production dependencies: 0 vulnerabilities. Under review (see Phase 0 status) |
| 2026-10-18 | Re-checked after installing Phase 0 dependencies: still the same 5 high-severity findings (`braces` GHSA-vfj7-8cjw-p6xm via `micromatch` → `fast-glob` → `@next/eslint-plugin-next` → `eslint-config-next`). Only offered fix is `--force`, which downgrades `eslint-config-next` to 14.2.35 (breaking) | Not fixed; `npm audit fix` / `--force` not run. `npm audit --omit=dev`: **0 vulnerabilities** – the new packages add no findings. Still under review |
| 2026-10-18 | Supplied `app/api/health/route.js` used `export const dynamic = 'force-dynamic'`, which Next.js 16 removes when `cacheComponents: true` (our config). A synchronous `better-sqlite3` query would also finish during prerendering, freezing the result at build time | Removed the `dynamic` export; `GET` now calls `await connection()` (from `next/server`) before the query, as the Next.js docs recommend for `better-sqlite3`. Build lists `/api/health` as `ƒ (Dynamic)` |
| 2026-10-18 | Section A tests: first run had 36 failures, all `EBUSY` during cleanup – `node:test` runs `t.after` hooks in registration order, so temp folders were deleted before their database connections closed (Windows refuses) | Test helper `onCleanup` runs cleanups last-in-first-out. 35 leftover temp folders deleted. No database code changed |
| 2026-10-18 | Section A: the tamper test using `PRAGMA writable_schema` failed with "table sqlite_master may not be modified" | Not a bug: better-sqlite3 runs SQLite in defensive mode, which blocks direct schema edits. Kept as its own test; the weakened-CHECK test now rebuilds the table instead |
| 2026-10-18 | Section A: a test expected `checkIntegrity` to fail when Better Auth tables were missing, but with no rows there is nothing to violate | Test removed; requirement moved to setup, which now checks all five Better Auth tables (D17) |
| 2026-10-18 | Section B: repeat-run test saw changed `*.db-wal` / `*.db-shm` files | SQLite keeps empty WAL/shared-memory files when the last connection is read-only. Database files themselves are byte-identical with unchanged modified times; tests ignore the runtime side files |
| 2026-10-18 | Section C: second setup run logged `ERROR [Better Auth]: Could not validate the database schema` | Better Auth checks its schema in the background after start-up; seeding had already closed the connection. Seeding now awaits that check (`await (await auth.$context).checkSchema()`), which also fails setup if the schema is wrong |
| 2026-10-18 | Section C: Better Auth's sign-up signs the new user in by default, so seeding would create sessions | Seeding passes `autoSignIn: false` (seeding only); test confirms 0 sessions after setup |
| 2026-10-18 | Step 3: the AI's shell on the home PC started with the system-wide Node 24, not the pinned 22.23.3 | Every command run with the Node 22 folder first on `PATH`; documented in `docs/SETUP.md` ("activate Node 22 first") |
| 2026-10-18 | 3A: build output tracing listed all of `data/` – including private keys and `*.env` – as files of `/api/health` (would be copied by a standalone/deployment build) | Runtime `data/` paths marked `turbopackIgnore`; `npm run test:http` fails if any trace lists runtime data (D38) |
| 2026-10-18 | 3A probe: direct `auth.api` calls skip Better Auth's Origin check (a foreign Origin was accepted) | CSRF protection moved to VaultPay's own Server Action check (D31) |
| 2026-10-18 | 3B: Next.js accepts a Server Action POST with no Origin header (logs a warning only) | `assertSameOrigin` refuses missing Origin; HTTP-tested for every action |
| 2026-10-18 | 3B: with Cache Components, a page's `redirect()` arrives after the static shell – full page loads get 200 plus an in-page `NEXT_REDIRECT` instead of 307 | Accepted; no protected content is in the response (HTTP checks verify the redirect target and the absence of protected text). Only the proxy's "no cookie" redirect is a real 307 |
| 2026-10-18 | 3C: `next build` opened the real identity DB – `getViewer()` started Better Auth before reading the request, so prerendering reached the database | Request read first; DB/Better Auth getters refuse to run during `next build` (verified by temporarily breaking the order: build fails) |
| 2026-10-18 | 3C: backup codes would have been lost – after the enrollment action, Next re-renders in the same request using the original Cookie header (the revoked session) and redirected to `/login` | DAL builds the cookie header from `cookies()` (includes the new session); the setup page no longer redirects verified users |
| 2026-10-18 | 3C: some HTTP checks matched text that was only in Next's Flight data (no-JS form POSTs deliver action state there, not in the rendered HTML) | HTTP checks read the returned action state explicitly; JS requirement recorded as a limitation |
| 2026-10-19 | 3D: Better Auth 1.7.10 accepted the same TOTP code for enrollment and two separate sign-in challenges in one 30-second window | Replay guard (D33); unit + HTTP tests |
| 2026-10-19 | 3E: a failed attempt's claim release matched on `claimed_at`; with two claims in the same millisecond (or a repeated release) it could delete another request's successful claim and reopen the code | Random claim token + one-shot release (identity migration 0003); regression test fails on the old code |
| 2026-10-19 | 3F review: **DNS rebinding** – a site resolving its own name to 127.0.0.1 could send "same-origin" Server Actions (`Host` and `Origin` both `evil.example`) and sign in to the published demo accounts from a victim's browser | Localhost `Host` allowlist in every Server Action, in session resolution and in `/api/health`; HTTP test sends real requests with a foreign Host – all three checks fail without the fix |
| 2026-10-19 | Test-only bugs found while writing HTTP checks: picking the page's first form (Sign out) instead of the lookup form; the rate-limit check locking Carol before her enrollment; random KYC timestamps making "later" records older | Forms selected by content; rate-limit check runs last; strictly increasing KYC timestamps (3 consecutive clean runs) |
| 2026-10-18 | Smoke test section 6 prints `ERROR [Better Auth]: Database schema mismatch – Missing tables session, account, verification, twoFactor` | Not a failure: `betterAuth()` checks the schema when initialized, and the test initializes it on an empty database before running migrations. The following checks confirm the migrations created all five tables and all 7 checks passed. The app must run migrations in `npm run setup` before startup. Test left unchanged |

---

## 4. Security tests

Step 2 tests are groundwork at the database / certificate / key level; end-to-end tests
follow once the services exist. All run with `npm test` (`node --test`).

| Threat | Test | Result | Date |
|--------|------|--------|------|
| 120 | Ledger `UPDATE`/`DELETE` blocked; postings must match a completed transfer (amount, sender debit, payee credit); one posting per side; reversals mirror an original exactly, once; transfer amount/parties immutable | Pass | 2026-10-18 |
| 305 | Safe open refuses missing files (never creates), links/junctions/hard links, non-SQLite files, the wrong database (identity vs transaction), older/newer schema, dropped/replaced/added triggers and tables, weakened CHECK | Pass (file-symlink case skipped: needs Windows Developer Mode) | 2026-10-18 |
| 280 | mTLS with generated certificates: CBI refuses no certificate, a certificate without client usage, and another installation's CA; Settlement refuses a CBI endpoint from another CA | Pass | 2026-10-18 |
| 85 | CBI → mock Core Banking handshake succeeds only with this installation's CA | Pass | 2026-10-18 |
| 82 | Only `fraud.env` holds the risk-decision signing key; Settlement holds only the public key; jose decision signed by Fraud verifies at Settlement; service token does not verify as a risk decision | Pass | 2026-10-18 |
| 282 | Settlement attempt and mock-bank posting idempotency keys are unique; outbox allows one live message per transfer and target | Pass | 2026-10-18 |
| 307 / D5 | Transfer cannot be sent to settlement without recording the attempt; cannot expire or be re-screened after an attempt; settlement needs an approved decision for the same transfer | Pass | 2026-10-18 |
| 244 | `support@example.test` is a `support_readonly` ops user, cannot also be a customer; read-only DB connections rejected with `SQLITE_READONLY` | Pass | 2026-10-18 |
| — (KYC baseline) | Carol seeded KYC pending; KYC history append-only; current status = newest record | Pass | 2026-10-18 |

Step 3 tests (authentication and access control). Unit tests run with `npm test`; HTTP
tests with `npm run test:http` against the built app on a temporary install, through real
Server Action form POSTs.

| Threat / control | Test | Result | Date |
|--------|------|--------|------|
| CSRF | Foreign-Origin and missing-Origin POSTs rejected for login, logout, TOTP enrollment, TOTP verification and support lookup (HTTP); static check that every Server Action calls `assertSameOrigin` first | Pass | 2026-10-19 |
| DNS rebinding | Login POST, session cookie and `/api/health` under `Host: evil.example` all refused (HTTP); fails without the fix | Pass | 2026-10-19 |
| Credential guessing | Generic error for wrong password / unknown email / malformed input; rate limit blocks the 6th attempt even with the right password; spoofed `X-Forwarded-For` gains nothing | Pass | 2026-10-18 |
| Sessions | Cookie `HttpOnly; SameSite=Lax; Path=/; Max-Age=1800`, host-only; logout revokes and clears; expired sessions refused and removed; page reads never extend a session | Pass | 2026-10-18 |
| MFA bypass | Password-only sessions (incl. an enrolled account's older session) denied every protected page; `mfaVerifiedAt` cannot be set by a client, copied forward or used outside its session's lifetime; no trusted-device cookie | Pass | 2026-10-18 |
| TOTP replay | Same code refused on a second challenge; enrollment code refused for sign-in; of two concurrent attempts exactly one succeeds; a failed attempt cannot release another's claim | Pass | 2026-10-19 |
| Backup codes | Work once; reuse refused | Pass | 2026-10-18 |
| 244 / support | Customers cannot reach `/support` (page or replayed action); support cannot reach `/wallet` or `/send`; support connections reject writes; lookups masked; ops accounts not findable | Pass | 2026-10-19 |
| Audit trail | Every search and view recorded before data is returned (fail closed); writer only appends registered types; `audit_event` and `audit_event_type` reject UPDATE/DELETE | Pass | 2026-10-19 |
| Data isolation (120) | Each customer sees only their own wallet and transfers; wallet id never taken from the request | Pass | 2026-10-19 |
| Account status / KYC | Suspended/closed customers, disabled ops users, role-less accounts refused; pending/rejected KYC, frozen/closed/missing wallets refused for sending; changes apply on the next request; an old viewer snapshot never outlives a database change | Pass | 2026-10-19 |
| D7 | No Next.js code opens the mock Core Banking database | Pass | 2026-10-19 |
| Build hygiene | No runtime data in build traces; build fails if prerendering reaches the database | Pass | 2026-10-18 |

---

## 5. Phase status

| Phase | Work laptop | Home PC | Notes |
|-------|-------------|---------|-------|
| 0 – Environment & scaffold | Environment verified; repo created and pushed; Next.js 16.4.1 starter runs; lint passes | Configured 2026-10-18: Node 22.23.3 / npm 10.9.9; repo cloned at `C:\dev\vaultpay`; `npm ci` succeeded; `npm run lint` passes; `npm run dev` starts and the starter page loads; git status clean. Phase 0 dependencies installed; `npm run smoke` 33/33 pass; `npm run lint` passes; `npm run build` succeeds; `/api/health` returns `{"status":"ok"}` under `npm run start` (see below) | Both computers configured; Node 22 pinned (D13). Remaining: on the work laptop, `npm ci`, `npm run smoke`, `npm run build` and the `/api/health` check |
| 2 – Setup, databases, PKI, secrets, demo data | Pending (needs Phase 0 laptop steps, then `npm ci` + `npm run setup`) | Done 2026-10-18 (Sections A–C): `npm test` 123 tests – 122 pass, 0 fail, 1 skipped (file symlinks need Developer Mode); `npm run setup` on the existing install added only the mock Core Banking DB and demo data (keys and certificates kept); repeat run kept everything; `npm run setup:check` 11/11 PASS; `NODE_ENV=production` refused; lint, build, smoke test pass | Not yet: login/TOTP UI, transfer endpoints, Fraud/Settlement/CBI services (later steps). `/api/health` still uses an in-memory DB |
| 3 – Authentication, MFA, roles, KYC | Pending (`git pull`, `npm ci`, `npm run setup` migrates to identity v3 / transaction v2) | Done 2026-10-19 (Sections 3A–3F): `npm test` 218 tests – 217 pass, 0 fail, 1 skipped; `npm run test:http` 134/134; lint, build, smoke, setup, `setup:check` 11/11 PASS; production audit 0 vulnerabilities | Next: Step 4 (Core Banking Integration, balances) and Step 5 (transfers, which must call `requireVerifiedCustomer()` again just before creating a transfer) |
| 4 – Core Banking integration and balances | Pending (`git pull`, `npm ci`, `npm run setup` – upgrades the secrets layout and issues the new certificates) | Done 2026-10-19 (4A–4C): `npm test` 254 – 253 pass, 0 fail, 1 skipped; `test:http` 144/144 (twice); `test:services` 28/28; `test:mock-bank` 10/10; lint, build, smoke, setup, `setup:check` pass; home PC upgraded in place | Next: Step 5 (transfers) – see "Before Step 5" below |

### Phase 0 dependency verification – home PC, 2026-10-18

Node.js 22.23.3, npm 10.9.9. Installed with `--save-exact`:

| Package | Version | Type |
|---|---|---|
| `better-auth` | 1.7.10 | dependency |
| `better-sqlite3` | 13.0.3 | dependency |
| `jose` | 6.2.12 | dependency |
| `zod` | 4.6.7 | dependency |
| `selfsigned` | 5.5.0 | devDependency |

`npm ls` shows one copy of each (`better-auth` uses the same `jose` and `zod`). No install errors or peer-dependency warnings; `better-sqlite3` installed without a local native build.

| Check | Result |
|---|---|
| `npm run smoke` | **33/33 pass**, exit code 0 – Node 1/1, better-sqlite3 5/5, Zod 5/5, jose 7/7, selfsigned + mTLS 8/8, Better Auth + two-factor 7/7 |
| Better Auth init message | `ERROR [Better Auth]: Database schema mismatch` printed before migrations ran; expected for the test's ordering, not a failure (see Problems, 2026-10-18) |
| `npm audit --omit=dev` | **0 vulnerabilities** (full audit: same 5 high-severity ESLint-chain findings as 2026-10-14) |
| `npm run lint` | Pass, no warnings |
| `npm run build` | Success (Next.js 16.4.1, Turbopack, Cache Components + Partial Prefetching enabled). `/` and `/_not-found` static; `/api/health` dynamic |
| `GET /api/health` under `npm run start` | HTTP 200, `application/json`, `{"status":"ok"}` (two requests) |

### Step 2 – setup, databases, certificates, secrets, demo data (home PC, 2026-10-18)

| Section | Delivered | Verified |
|---|---|---|
| A – database layer | Identity + Transaction schemas v1, versioned migrations, fail-closed safe open, `checkIntegrity` | 72 pass / 1 skip at the time |
| B – setup | `npm run setup`, `npm run setup:check`, dev CA + 4 service certificates, 6 per-process env files with Ed25519 keys, Better Auth migrations, ACLs, reset flags | 101 pass / 1 skip; fresh + repeat setup on this PC; ACL = current user only |
| C – demo data + docs | Mock Core Banking DB, seeded demo users/customers/KYC/wallets/merchant/balances, `docs/SETUP.md`, README setup section | See below |

Final Section C results are recorded in the Phase status row and in the Problems table.

### Step 3 – authentication, MFA, roles and KYC (home PC, 2026-10-18 – 2026-10-19)

| Section | Delivered | Verified (unit / HTTP) |
|---|---|---|
| 3A – app wiring | Next.js connected to the identity DB and Better Auth; safe `web.env` loader; `/api/health` on the real databases (status only); localhost binding; security headers; build-trace fix | 140 pass / 1 skip; HTTP checks introduced |
| 3B – login and sessions | `/login` Server Action, generic errors, 30-min sessions, logout/revocation, rate limiter, DAL, convenience proxy, explicit Origin check | 167 / 1 skip; 63 HTTP |
| 3C – TOTP MFA | First-login enrollment (password, QR + key, first code, backup codes once), sign-in challenge, backup codes, `mfaVerifiedAt` session marker, MFA rate limits, build guard | 180 / 1 skip; 96 HTTP |
| 3D – roles | TOTP replay guard; `requireCustomer` / `requireSupport`; `/wallet`, `/support`, `/access-denied`; audit writer and event types; data isolation | 204 / 1 skip; 119 HTTP |
| 3E – KYC eligibility | `requireVerifiedCustomer()` / `lib/server/eligibility.js`; `/send` placeholder; claim-token fix | 212 / 1 skip; 131 HTTP |
| 3F – review and docs | DNS-rebinding fix; static security-invariant tests; `docs/SETUP.md`, README and this log updated | **217 / 1 skip; 134 HTTP** |

**Known limitations after Step 3**

- Plain HTTP on localhost: cookies are not `Secure`, no HSTS, no nonce-based CSP yet.
- Multi-step pages (enrollment, MFA challenge, support lookup) need JavaScript: action
  results arrive in Next's Flight data.
- Protected pages redirect with 200 + in-page `NEXT_REDIRECT` on full page loads (Cache
  Components); no protected content is sent.
- Rate limits are in memory (reset on restart, per process); anyone local who knows a
  published demo password can lock that account for 15 minutes or be first to enrol its TOTP.
- The challenge rate-limit key reads Better Auth's `verification` table (internal format).
- The audit writer is narrow by API and triggers, not by database permissions (SQLite has
  none, D3); audit events do not record the searched email.
- A customer with several wallets: the DAL shows the oldest, eligibility prefers an active
  one – Step 5 must take the source wallet explicitly and check ownership and status.
- No KYC approval screen, no password reset, email verification or self-registration.
- One test is skipped on this PC: file symlinks need Windows Developer Mode.

**Next steps**

- Work laptop: `git pull`, `npm ci`, `npm run setup` (migrates to identity v3 /
  transaction v2), `npm test`, `npm run build`, `npm run test:http`.
- Step 4: Core Banking Integration over mTLS (balances on `/wallet`).
- Step 5: transfers – call `requireVerifiedCustomer()` immediately before creating each
  transfer, take the source wallet explicitly, add the transfer audit event types.

### Step 4 – Core Banking integration and balances (home PC, 2026-10-19)

| Section | Delivered | Verified |
|---|---|---|
| 4A | Mock Core Banking HTTPS process (mTLS, CN allowlist `vaultpay-cbi` + credential, read-only balance endpoint); narrow CBI → bank client (server CN pinned, 3 s deadline, strict schema) | 17 integration tests; `test:mock-bank` 10/10 against the real process and the home PC install |
| 4B | Identity process (only holder of the signing key; one purpose-specific endpoint), CBI process, service tokens (EdDSA, `typ`, `kid`, fixed `aud`/`sub`/`scope`, `cnf` certificate binding, 30 s, single-use `jti`), balances on `/wallet`; secrets-layout upgrade path | 12 balance-flow tests, 2 upgrade tests; `test:services` 28/28; home PC upgraded with the same key id and Better Auth secret |
| 4C | Review of the full flow against `docs/SERVICE_AUTH.md`; regression test for oversized request bodies; doc wording fixed ("fails closed", not "refuses to start"); end-to-end scenario extended to Bob | 254 unit tests (253 pass, 1 skip); `test:http` 144/144 twice |

**End-to-end scenario (real processes: Next.js, Identity, CBI, mock Core Banking):** Alice
signs in and completes TOTP → `/wallet` shows **$500.00**; Bob sees **$250.00** and Carol
**$100.00**, never Alice's; support is refused `/wallet` (and Identity refuses support and
password-only sessions); a frozen wallet shows no balance; stopping mock Core Banking, then
CBI, shows "Your balance is temporarily unavailable" with nothing internal on the page.

**4C review result:** no code defects found. Checked: oversized/garbled bodies at Identity
(connection cut, service keeps serving – now a regression test); token single use is
recorded before the bank call; Identity re-checks session expiry, MFA marker, customer and
wallet status itself; Next.js additionally rejects a balance for a different wallet;
every outage maps to the generic message; Next.js loads only `web.env` and fails closed if it
holds another process's secret.

**Before Step 5 (transfers)**

- **New token purpose:** `corebanking.settlement:submit` needs its own Identity endpoint
  (bound to transfer id, amount, currency and idempotency key) and its own CBI scope for
  `sub vaultpay-settlement`; Settlement needs a server certificate if Next.js/Orchestrator
  calls it over mTLS (only a client certificate exists today).
- **Mock bank writes:** postings need a writable bank connection and an idempotent posting
  endpoint (the `posting` table and unique idempotency key exist since Step 2).
- **Replay state is in memory** per CBI process; a settlement token must additionally be
  idempotent at the bank, since a CBI restart forgets used `jti`s within the 30 s window.
- **Source wallet:** the DAL shows the oldest wallet, eligibility prefers an active one –
  transfers must take the source wallet explicitly and re-check ownership and status.
- **Audit event types** for transfers must be registered by a new transaction migration.
- **Fraud & Risk Check / Settlement processes** do not exist yet; their certificates and
  keys from Step 2 are unused so far (`mock-fraud-scoring` has no certificate).
- Services are started by hand (`npm run services`); there is no supervisor.

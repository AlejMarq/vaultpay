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
| D9 | 2026-10-14 | Certificates | `selfsigned` 5.x (pure JS, devDependency, setup-time only); one dev CA, peer name checks, Core Banking Integration permissions derived from client certificate | **Accepted, conditional** on verifying the library works | `selfsigned` 5.5.0 verified on the home PC (smoke test section 5: 8/8 pass, 2026-10-18). Work laptop pending. |
| D10 | 2026-10-14 | Service tokens | Ed25519 tokens using Node's built-in crypto, fixed format, strict validation (iss, aud, scope, transfer_id, iat/exp ≤ 60 s) | **Accepted**; asked for a brief comparison with `jose` before implementing auth | **Original proposal (accepted 2026-10-14):** Node built-in crypto. **Later AI recommendation:** use `jose` (`EdDSA`, with strict `algorithms` / `issuer` / `audience` / `maxTokenAge` / `requiredClaims` checks); it is included in the Phase 0 smoke test only to confirm it works. **Not yet adopted** – the built-in crypto decision stands until the comparison is done and I approve a change (due before Phase 2). |
| D11 | 2026-10-14 | Packaging | `git archive` + secret scan of the ZIP | **Accepted** | Applies at final packaging. |
| D12 | 2026-10-14 | Two-computer workflow | — | **My requirement** – work laptop + home PC synced through a private GitHub repo, project at `C:\dev\vaultpay` on both | Single `main` branch; pull before starting, push before leaving; each computer generates its own certificates, secrets and databases with `npm ci` + `npm run setup`; nothing machine-specific is committed. |
| D13 | 2026-10-18 | Node.js version | — | **My requirement** – both computers use the same Node.js version | Node.js 22 pinned: `.nvmrc` = `22.23.3`, `package.json` `engines.node` = `>=22.0.0 <23.0.0` (commit 7644763). Home PC verified on Node 22.23.3 / npm 10.9.9. |

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

---

## 3. Problems and resolutions

| Date | Problem | Resolution |
|------|---------|------------|
| 2026-10-14 | The AI's workspace cannot reach the npm registry (blocked by policy), so it can't install or run the app's packages | All installs and runtime tests run on my Windows machines; the AI checks built-in-only code before handing it over |
| 2026-10-18 | AI's first draft of the smoke test read the server certificate after the HTTPS response ended; the socket is released by then, so it crashed. Caught when the AI ran the mTLS section against OpenSSL-made certificates before handing it over | Read the peer certificate when the response starts; use a fresh connection per check (`agent: false`) |
| 2026-10-14 | `npm audit` (full) reports 5 high-severity findings in the ESLint dependency chain (`braces`); no non-breaking fix offered | Did not run `npm audit fix --force`. Production dependencies: 0 vulnerabilities. Under review (see Phase 0 status) |
| 2026-10-18 | Re-checked after installing Phase 0 dependencies: still the same 5 high-severity findings (`braces` GHSA-vfj7-8cjw-p6xm via `micromatch` → `fast-glob` → `@next/eslint-plugin-next` → `eslint-config-next`). Only offered fix is `--force`, which downgrades `eslint-config-next` to 14.2.35 (breaking) | Not fixed; `npm audit fix` / `--force` not run. `npm audit --omit=dev`: **0 vulnerabilities** – the new packages add no findings. Still under review |
| 2026-10-18 | Supplied `app/api/health/route.js` used `export const dynamic = 'force-dynamic'`, which Next.js 16 removes when `cacheComponents: true` (our config). A synchronous `better-sqlite3` query would also finish during prerendering, freezing the result at build time | Removed the `dynamic` export; `GET` now calls `await connection()` (from `next/server`) before the query, as the Next.js docs recommend for `better-sqlite3`. Build lists `/api/health` as `ƒ (Dynamic)` |
| 2026-10-18 | Smoke test section 6 prints `ERROR [Better Auth]: Database schema mismatch – Missing tables session, account, verification, twoFactor` | Not a failure: `betterAuth()` checks the schema when initialized, and the test initializes it on an empty database before running migrations. The following checks confirm the migrations created all five tables and all 7 checks passed. The app must run migrations in `npm run setup` before startup. Test left unchanged |

---

## 4. Security tests

| Threat | Test | Result | Date |
|--------|------|--------|------|
| — | None yet (Phase 0 has no security controls) | — | — |

---

## 5. Phase status

| Phase | Work laptop | Home PC | Notes |
|-------|-------------|---------|-------|
| 0 – Environment & scaffold | Environment verified; repo created and pushed; Next.js 16.4.1 starter runs; lint passes | Configured 2026-10-18: Node 22.23.3 / npm 10.9.9; repo cloned at `C:\dev\vaultpay`; `npm ci` succeeded; `npm run lint` passes; `npm run dev` starts and the starter page loads; git status clean. Phase 0 dependencies installed; `npm run smoke` 33/33 pass; `npm run lint` passes; `npm run build` succeeds; `/api/health` returns `{"status":"ok"}` under `npm run start` (see below) | Both computers configured; Node 22 pinned (D13). Remaining: on the work laptop, `npm ci`, `npm run smoke`, `npm run build` and the `/api/health` check |

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

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
| D47 | 2026-10-19 | Who writes transfers (Step 5) | The Orchestrator & Ledger (inside Next.js, D1) | **AI proposal, within my requirement** (narrow writer, reuse existing patterns) | `lib/server/transfer-orchestrator.js`: own writable connection, one operation `create()`; a static test allows writable transaction-DB connections only here and in the audit writer, and forbids `UPDATE transfer`, ledger, settlement and risk inserts in Next.js code. |
| D48 | 2026-10-19 | Atomicity and recovery | Transfer, `transfer.requested` audit event and `fraud_check` outbox message in one `BEGIN IMMEDIATE` transaction | **My requirement** (one DB transaction, durable outbox) | Outbox (307) is the recovery mechanism for Step 6: an accepted transfer always has a pending message; a failure leaves no row at all (tested by forcing the outbox insert to fail). |
| D49 | 2026-10-19 | Idempotency | Database only: existing `UNIQUE(sender_wallet_id, idempotency_key)`; same key + same payee/amount/currency → the stored transfer; different payload → `idempotency_conflict` | **My requirement** (no in-memory idempotency) | No new column needed: the payload is compared with the stored row inside the write transaction; a unique-constraint race from another connection is answered from the winning row. Key = random UUID issued at review, one per intended transfer. |
| D50 | 2026-10-19 | Preliminary funds check | CBI balance minus this wallet's transfers in `pending_risk` / `pending_settlement` / `settlement_in_flight` (holds), computed inside the write transaction | **AI proposal** – Core Banking balances do not change until settlement, so without holds two pending transfers could spend the same money | Fails closed if the balance is unavailable; a replay of an already-recorded key is answered from the DB without the bank. The bank posting (Step 7) must enforce funds independently. |
| D51 | 2026-10-19 | Limits and lifecycle | $0.01–$1,000.00 business limit (separate from the DB ceiling, D16); 1-hour `pending_expires_at`; new transfers `pending_risk` only | **AI proposal** | `TRANSFER_TRANSITIONS` in code mirrors the DB trigger (a test checks all 42 status pairs against the database). |
| D52 | 2026-10-19 | Recipient and source wallet | Recipient by email, active customer + active wallet; one generic refusal; review does not look the recipient up; source wallet = server-resolved active wallet, which must also be the wallet the balance flow uses | **AI proposal** (privacy: no account enumeration at review, no recipient name shown) | The browser's `sourceWalletId` is only compared, never used; a customer whose first wallet is not the active one cannot send (fails closed, see limitations). Recipients need not have approved KYC. |
| D53 | 2026-10-19 | Form flow | Two-step Server Action (`intent` review → confirm); results via `useActionState`; fixed error codes mapped to messages in the client | **AI proposal** | Eligibility is re-checked in the action, again at the start of `initiateTransfer`, and once more synchronously right before the write (after the balance call). |
| D54 | 2026-10-19 | Fraud & Risk process (Step 6) | Separate Node.js HTTPS process `services/fraud/`, 127.0.0.1:4400, no database, only holder of the risk-decision signing key; new server certificate `vaultpay-fraud` | **My requirement** (separate process, own credentials) | Accepts only `CN=vaultpay-orchestrator`; strict request schema; `400` without signing anything for invalid requests. |
| D55 | 2026-10-19 | Who consumes the outbox | A separate worker command `npm run fraud-worker` (Orchestrator role, D1) with its own `orchestrator.env` (risk-decision **public** key, client certificate `vaultpay-orchestrator`) | **AI proposal** – a request-driven Next.js process cannot run a durable background loop; the Orchestrator's writer stays outside the browser path | Next.js imports neither the worker nor the fraud signer (static test). |
| D56 | 2026-10-19 | Decision format | Compact JWS (jose, EdDSA), `typ vaultpay-risk-decision+jwt`, `kid`, `iss vaultpay-fraud`, `aud vaultpay-orchestrator`, `sub`/`transfer` binding, `req` request binding, `jti` decision id, 10-minute `exp` | **AI proposal, within my requirement** (bind transfer id, parties, amount, currency, outcome; iat/exp/unique id) | Different key and `typ` from service tokens, so neither can pass for the other (tested). Stored verbatim in `risk_decision.signature` for Settlement to re-verify in Step 7. |
| D57 | 2026-10-19 | Concurrency and crash safety | Database leases on `outbox_message` (`leased`, `lease_until`, `attempts`), `attempts` as fencing token, `BEGIN IMMEDIATE` for claim and apply | **My requirement** (durable claims, not memory) | No schema change needed: the Step 2 outbox columns (D8) suffice. Lease 30 s; backoff 1 s × 2ⁿ up to 60 s; `dead` after 10 attempts – the transfer then stays `pending_risk`. |
| D58 | 2026-10-19 | Mock engine rules | Deterministic: decline at ≥ `VAULTPAY_FRAUD_DECLINE_AT_CENTS` (default $250.00), same wallet, block list (`VAULTPAY_FRAUD_BLOCKED_PAYEES`), implausible time; else approve with score ∝ amount | **AI proposal** – default below Alice's $500 so both outcomes can be shown | Thresholds are demo settings in the Fraud process environment, not secrets. The external "mock fraud scoring" vendor (Step 2 key) is not used. |
| D59 | 2026-10-19 | After approval | Same apply transaction enqueues a `settlement` outbox message | **AI proposal** (recovery mechanism for Step 7; no settlement implemented) | Declines enqueue nothing and stop holding funds. |
| D60 | 2026-10-19 | Upgrade path | `npm run setup` adds TLS paths to `fraud.env`, creates `orchestrator.env` from the existing signing key's public half (old `fraud.env` backed up), issues `fraud` + `orchestrator` certificates from the existing CA, migrates transaction DB to v4 | **AI proposal** (as D46) | Verified on the home PC: risk-decision key id `rd-056ea85a88f059dd` kept. |
| D61 | 2026-10-19 | Settlement process (Step 7) | Separate HTTPS process `services/settlement/`, 127.0.0.1:4500, one endpoint for one caller (`vaultpay-orchestrator`), no database, no bank credential; new server certificate `settlement-server` (CN `vaultpay-settlement`) because the Step 2 `settlement` certificate is client-only | **My requirement** (own server certificate, narrow interface) | Re-verifies the approval itself before asking Identity. |
| D62 | 2026-10-19 | Settlement token issuance | Identity `POST /v1/service-tokens/settlement` for `vaultpay-settlement` only; input = the fraud approval + idempotency key; Identity verifies the approval (new: risk-decision public key in `identity.env`) and maps parties to bank accounts itself | **My requirement** (purpose-specific, bound to transfer, accounts, amount, currency, key) – the design detail (approval as the authorization) is the AI's | A compromised Settlement can get tokens only for transfers Fraud & Risk approved, and only to the parties' own accounts. |
| D63 | 2026-10-19 | CBI posting | `POST /v1/postings`, token only, no body; posting details only from the token; separate scope per caller; balance and posting routes refuse each other's caller | **My requirement** | `504 {outcome:"unknown"}` for every non-definitive bank result. |
| D64 | 2026-10-19 | Bank idempotency and funds | Bank checks the idempotency key FIRST (original result or `409` on a different payload), then active accounts and funds, then debit/credit/posting in one `BEGIN IMMEDIATE` transaction; schema guards as a second line (`balance_cents >= 0`, active-account trigger) | **My requirement** | Refusals are not recorded at the bank; a retry after a lost refusal is evaluated again (it can never move money twice). |
| D65 | 2026-10-19 | Unknown outcomes | Retry with the SAME key while the approval is valid; if it expires while unknown → message `dead`, `needs_reconciliation`, transfer stays `settlement_in_flight` (never failed by guesswork) | **My requirement** (same key, no new posting) – parking instead of an expired-approval retry is the AI's choice | Reconciliation (Step 8 scope) resolves parked transfers. |
| D66 | 2026-10-19 | "Refused before the bank" | Definitive (transfer `failed`) only when the attempt was created in the same claim – its key had never been sent; otherwise treated as unknown | **AI proposal** – an earlier, unanswered send with that key may have posted | Keeps a frozen-wallet refusal from leaving money in limbo, without ever risking a false failure. |
| D67 | 2026-10-19 | Ledger and completion guards | Migration 0005: ledger ↔ bank posting reference, credit-after-debit, completed/failed need the matching attempt, settlement message of a completed transfer needs exactly one debit and one credit; `ledger_totals` view | **AI proposal, within my requirement** (balanced entries, no duplicates, linked to posting ids) | Historical migrations untouched; SQLite cannot defer a check to COMMIT, so balance is enforced at the outbox-completion step of the same transaction. |
| D68 | 2026-10-19 | Test/demo knobs | `VAULTPAY_MOCK_BANK_POST_DELAY_MS` (bank answers after committing – simulated lost response) and `VAULTPAY_SETTLEMENT_LEASE_MS` (shorter lease to show crash recovery quickly) | **AI proposal** | Mock bank and worker only; documented; defaults off / 60 s. |
| D69 | 2026-10-19 | Where reconciliation runs | Its own process `npm run reconcile` with `recon.env` (the Step 2 `vaultpay-recon` client certificate); the certificate paths move out of `web.env` | **My requirement** (Next.js isolated from privileged service credentials) – D1 had Reconciliation inside Next.js | Next.js now holds exactly one service identity (`vaultpay-web`). Upgrade moves the paths in place (D46 style). |
| D70 | 2026-10-19 | How the bank is asked | Purpose-specific read-only lookup: Identity `…/reconciliation` token (`records:read`, accounts from Identity's records) → CBI `POST /v1/postings/lookup` (no body) → bank `GET /v1/postings/{key}`; CBI compares and returns posted / not_found / mismatch / unknown, never accounts | **My requirement** (through CBI, narrowly scoped, existing Identity tokens) | Lookup by the attempt's own key only – reconciliation cannot post or choose another key. |
| D71 | 2026-10-19 | When a missing posting may fail a transfer | Only if no message for the transfer is leased (even expired) and none was active for 2 min; otherwise unresolved | **AI proposal** – a worker that still holds a lease could be sending the key | Ambiguous transfers keep their funds reserved until the bank confirms either way.  **Superseded by D76 (Step 9).** |
| D72 | 2026-10-19 | Mismatches and integrity | `reconciliation_result` `mismatched` recorded once per transfer, transfer left in flight; ledger issues audited every pass, never corrected | **My requirement** (flag, do not silently correct) | Shown on `/operations` as exceptions / integrity issues. |
| D73 | 2026-10-19 | Expiry and requeue | Expiry only for `pending_risk`/`pending_settlement` without `settlement_attempted_at` and without a live lease (the D5 CHECK forbids anything else); requeue only behind `--requeue-dead --once`, only for not-yet-sent transfers, as a NEW message | **AI proposal, within my requirement** (preserve leases, fencing, idempotency) | Parked messages stay as they are (append-only history); in-flight settlements are never requeued. |
| D74 | 2026-10-19 | Operations page | `/operations` for MFA-verified `support_readonly` only; read-only connection; no forms or actions; transfer ids and aggregates only; each view audited (`support.operations_view`) before data | **My requirement** | Next renders the page twice per full load; views are de-duplicated per session for 2 s (see Problems). |
| D75 | 2026-10-19 | Test/demo knob | `VAULTPAY_RECONCILE_MIN_AGE_MS` (default 120000) | **AI proposal** | Lets the real-process checks and the demo reconcile within seconds. |
| D76 | 2026-10-19 | Step 9 review: "no posting found" | Never fails a transfer. Left unresolved (audit `reconciliation.unresolved`), funds reserved; the next pass completes it if the posting appears; otherwise manual resolution with the bank | **My requirement** ("if it cannot be guaranteed, keep it unresolved") after the AI's analysis showed the D71 conditions are not a guarantee | Released lease ≠ finished request: CBI stops waiting after 3 s, but a request already inside the bank commits when it gets its SQLite lock (up to 5 s busy timeout) or after any process pause. Regression test races a late posting with reconciliation. |
| D77 | 2026-10-19 | Step 9 review: bank refusal after an unanswered send | `rejected` is definitive only for an attempt created in the same claim (key sent exactly once); otherwise treated as unknown and retried with the same key | **AI proposal** (same race as D76, found in the same review) | Otherwise an earlier copy of the request could post after the refusal and leave a `failed` transfer debited at the bank. Regression test. |
| D78 | 2026-10-19 | Final compliance review – threat 121 (Critical, rank 1) | Assignment 5 names per-account, per-route rate limits on the transfer route and per-account/global pending-backlog limits; only login/MFA were limited | **My requirement** (meet the Assignment 4/5 documents) – the AI found the gap when comparing code with the originals | `createTransferRateLimiter` (30 confirmations/min per customer, checked before any work), `MAX_PENDING_PER_WALLET` 20 / `MAX_PENDING_TOTAL` 2,000 inside the write transaction; "try again later" messages; unit, concurrency and HTTP tests. |
| D79 | 2026-10-19 | Final compliance review – threat 284 | Assignment 5's primary control is Reconciliation & Audit comparing VaultPay's records with Core Banking's; only open outcomes were reconciled | **My requirement** – gap found in the same review | `verifyFinished`: every completed/failed transfer is compared once with the bank's record for its key through the existing read-only lookup; matched/mismatched recorded, mismatches audited and shown on `/operations`, never corrected; tests simulate three kinds of tampered settlement results. |

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
| Transfer API idempotency via a request header | Idempotency key is a hidden form field issued by the server at review; uniqueness and payload match enforced by the transaction database | Server Actions instead of an HTTP API (D26, D53) |
| Funds check before accepting a transfer | Preliminary check: Core Banking balance minus pending transfers (D50); the bank posting enforces funds again | Core Banking is the source of truth (D7) and is only debited at settlement |
| Orchestrator runs inside Next.js | The fraud outbox consumer runs as its own process (`npm run fraud-worker`); the transfer writer for `/send` stays in Next.js | Background processing needs a long-running process (D55) |
| Fraud & Risk calls an external scoring vendor | Deterministic built-in rules; the mock scoring key from Step 2 is unused | A demo that always gives the same, explainable answer (D58) |
| Settlement holds the risk-decision public key and calls Identity for a settlement token | As designed, plus Identity also verifies the approval before issuing (D62) | Defense in depth: neither Settlement nor Identity alone can start a posting without a fraud approval |
| Ledger entries keyed by `wallet_id` | `account_type`/`account_id` (Step 2) plus `core_banking_ref` linking each entry to the bank posting (migration 0005) | Requirement to link ledger records to bank posting ids |
| Reconciliation & Audit runs inside Next.js (D1) | A separate `npm run reconcile` process with its own certificate file | Keeps Next.js free of any second service credential (D69) |
| Ops Portal with operational actions | Read-only `/operations` for support; recovery actions only as an operator command on the server | Support stays read-only (Step 3 requirement); no transfer, settlement or KYC actions in the browser |
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
| 2026-10-19 | Step 5: two existing tests hard-coded transaction schema v2 and the audit type list | Updated to v3 / `transfer.requested` (expected change, not a regression) |
| 2026-10-19 | Step 5 HTTP checks: a `redirect()` inside a Server Action arrives as a real `303` for a no-JS POST (not an in-page `NEXT_REDIRECT`), so the first version read no redirect target | Check helper reads the `Location` header (`redirectOf`); no app change |
| 2026-10-19 | Step 5 test cleanup: a test connection closed with `t.after` hit `EBUSY` on Windows | Uses `onCleanup` (last-in-first-out), as the other tests do |
| 2026-10-19 | Step 6: the AI's shell tool rewrote `\\n` inside heredocs into real newlines, which broke a generated JavaScript string (`join('\n')`) and a regex in the HTTP check | Caught by lint and a failing check; patches written with the editor tool instead of shell heredocs |
| 2026-10-19 | Step 6: four existing tests hard-coded the certificate list, process files, the risk public-key holders and schema v3 | Updated to the new `fraud`/`orchestrator` certificates, `orchestrator.env` and v4 (expected change) |
| 2026-10-19 | Step 7: the Step 4B upgrade path built `identity.env` from a spec that now includes the risk-decision public key, which a pre-4B install does not have (crash in the upgrade test) | Older upgrades skip settings that a later upgrade adds; the Step 7 upgrade fills each missing part independently (regression: `upgrade-4b`, `upgrade-7` tests) |
| 2026-10-19 | Step 7: the first expired-approval test moved the test clock and fed it to the in-process Fraud service, so Identity (real clock) saw approvals issued in the future | Test uses an injectable approval margin and a genuinely old signed approval instead of shifting service clocks |
| 2026-10-19 | Step 7: settlement tests failed intermittently (2 of ~15 full `npm test` runs) – the shared test harness gave CBI only 1.5 s for the bank, so under full-suite load a normal posting sometimes came back "unknown" and was (correctly) retried instead of completing in one run | Settlement harness uses the production 3 s bank deadline (timeout test delays 4 s); recovery steps allow bounded retries and assert the end state (completed, one posting). 9 consecutive clean runs afterwards. Not a product defect: the worker behaved as designed |
| 2026-10-19 | Step 7: existing schema and seed tests inserted ledger rows without a bank reference, postings with positional columns, and expected v4 | Updated to the v5/v2 guards (expected change); new tests for each new trigger |
| 2026-10-19 | Step 8: one full page load of `/operations` wrote two `support.operations_view` rows – Next 16 (Cache Components) renders the page twice for one request; the same happens to `/wallet`'s balance call (two log lines per load, seen since Step 4). React `cache()` did not span the two passes | Views recorded once per session within 2 s (in-memory de-duplication only; the record is still written before the first data, and an audit failure still stops the page). HTTP check: one row per load, a new row on a later reload |
| 2026-10-19 | Step 8: first versions of three reconciliation tests had setup mistakes (a "too recent" check that the real bank delay had already outlived; an expiry scenario whose helper approved every pending transfer; an assertion on a transfer id the overview deliberately does not list) | Test setup corrected; no product change |
| 2026-10-19 | **Step 9 review – correctness defect:** reconciliation marked a transfer `failed` when the bank had no posting for its key and no worker had touched it for 2 minutes. That is not authoritative: a request already delivered to the bank can commit later (lock wait, pause), leaving a failed transfer debited with no ledger entry. The same race existed for a bank refusal received on a retry | D76, D77: absence never fails a transfer; a refusal fails only a first-and-only send. Two regression tests (late posting after a "not found" lookup; refusal after an unanswered send) and the real-process check updated |
| 2026-10-19 | Step 9 packaging check: `npm ci` in a fresh copy of the submission ZIP stopped at `better-sqlite3` (`gyp ERR! … Could not find any Visual Studio installation`) – npm ran `node-gyp rebuild` although the package declares `"gypfile": false` and ships `prebuilds/win32-x64.node`; this PC has no C++ build tools. The working install in `C:\dev\vaultpay` was never compiled | Documented `npm.cmd ci --ignore-scripts` (no dependency needs an install script on Windows); verified on the fresh copy: lint, `npm test`, setup, `setup:check`, build, `test:http`, `test:settlement`, `test:reconcile` pass. No dependency changed |
| 2026-10-19 | Step 9 packaging check: the test "generated paths are git-ignored" failed in the ZIP copy (no `.git`; `git archive` excludes it by design) | Test skips outside a git checkout, as `npm run setup` already does |
| 2026-10-19 | **Final compliance review** against my original Assignment 4 ("Top 15 – Prioritized Threats for VaultPay") and Assignment 5 ("VaultPay – Next.js Threat-Mitigation Architecture") documents: two prioritized threats lacked the primary control Assignment 5 names – 121 (no per-account/per-route limit on transfers, no backlog limits) and 284 (finished transfers never compared with the bank). Earlier steps had worked from this log's summary of the design, not the original documents | D78, D79 implemented with tests; README threat-to-control table rebuilt from the original Assignment 4 list; remaining deviations from Assignment 5 listed in the README |
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

Step 5 tests (transfers): `tests/app/transfers.test.mjs` (real Identity, CBI and mock bank
in-process, real databases; worker threads for concurrent connections) and the
"Send money: transfers" section of `npm run test:http` (real processes, real form POSTs).

| Threat / control | Test | Result | Date |
|--------|------|--------|------|
| Happy path | Alice → Bob $12.50: one `pending_risk` transfer, one `transfer.requested` audit event, one `fraud_check` outbox message, no ledger rows; shown as pending to Alice and Bob, not to Carol | Pass | 2026-10-19 |
| Eligibility | Carol (KYC pending / rejected), support (wrong role), password-only session, frozen wallet, suspended customer refused – page, action replay and library; a freeze/KYC change during the balance call still stops the write | Pass | 2026-10-19 |
| Input validation | Invalid amounts (`abc`, `12.345`, `-5`, `1e2`, `1,000`, `01`), limits ($0 and $1,000.01), self-transfers (any case), malformed keys, number-typed fields refused; float pitfalls (`0.29`, `1.15`) parsed exactly | Pass | 2026-10-19 |
| Isolation (120) | Another customer's wallet as `sourceWalletId` refused; unknown, staff, suspended and frozen recipients get one identical answer; review never looks the recipient up; no recipient name, customer id or bank data in responses | Pass | 2026-10-19 |
| Funds | Over balance refused; pending transfers held (400 + 100.01 > 500 refused); Carol $100.01 refused over HTTP | Pass | 2026-10-19 |
| Idempotency (282) | Same key → same transfer (sequential, 10 parallel in-process, 5 parallel HTTP POSTs, 6 worker-thread connections); different amount or recipient → conflict; key scoped per sender | Pass | 2026-10-19 |
| Concurrency | 6 concurrent $200 transfers on separate connections against $490 available: exactly 2 accepted | Pass | 2026-10-19 |
| Fail closed | Bank or CBI down, malformed/foreign-currency/frozen balance → not accepted, nothing written, same key kept; an already-recorded key still answers from the DB | Pass | 2026-10-19 |
| Atomicity (307) | Forced outbox failure and a read-only connection: no transfer, audit or outbox row; error stays in the server log; retry with the same key creates exactly one | Pass | 2026-10-19 |
| Lifecycle | Code transition table equals the DB trigger for all status pairs; inserts other than `pending_risk` refused; nothing reported or stored as completed | Pass | 2026-10-19 |
| CSRF / rebinding | Foreign-Origin, missing-Origin and foreign-Host transfer POSTs refused, nothing written | Pass | 2026-10-19 |
| D7 / keys | Static check: no Next.js code opens the bank DB or names the signing key or bank credential | Pass | 2026-10-19 |

Step 6 tests (fraud screening): `tests/services/fraud.test.mjs` (real mTLS Fraud & Risk
in-process, real databases), `npm run test:fraud` (real Fraud & Risk process and worker
command, three concurrent worker processes), the "Fraud screening" section of
`npm run test:http`, and `tests/setup/upgrade-6.test.mjs`.

| Threat / control | Test | Result | Date |
|--------|------|--------|------|
| Approve / decline | $12.50 → `pending_settlement` + decision + `transfer.risk_approved` + settlement outbox; $300.00 → `declined` + `transfer.risk_declined`, no settlement message; `/wallet` shows *Pending – awaiting settlement* / *Declined* (HTTP) | Pass | 2026-10-19 |
| 82 – forged / tampered | Edited outcome, amount, payee, request id or expiry → signature fails; another installation's key, Identity's service-token key, wrong `typ`, unknown `kid`, extra claims, over-long lifetime refused | Pass | 2026-10-19 |
| Binding | Decision for another transfer, amount, payee, sender or payee type → `wrong_transfer`; for another or older request → `wrong_request` | Pass | 2026-10-19 |
| Expired / replayed / duplicate | Expired decision refused; transfer A's approval replayed for B refused; reused decision id refused by the primary key; duplicate `fraud_check` delivery skipped without asking Fraud & Risk | Pass | 2026-10-19 |
| Concurrency | 3 in-process workers (separate connections) and 3 worker processes: every transfer screened and applied exactly once, every message `done` with 1 attempt | Pass | 2026-10-19 |
| Crash / retry | Abandoned claim recovered after the lease; a stale worker holding a valid decision is fenced out (`lease_lost`); a failure inside the apply transaction rolls back decision, status, audit and outbox | Pass | 2026-10-19 |
| Outage | Fraud & Risk down, `500`, or `200` without a decision → `pending_risk`, backoff, screened once the service is back; `dead` after 10 attempts, still `pending_risk` | Pass | 2026-10-19 |
| Caller isolation | Fraud & Risk refuses `vaultpay-web`; the worker refuses a server with another service's certificate; Next.js code imports no fraud/worker code and no risk key | Pass | 2026-10-19 |
| Leakage | Worker and service logs and `/wallet` contain no JWS, decision id, score, rule or key | Pass | 2026-10-19 |

Step 7 tests (settlement): `tests/services/settlement.test.mjs` (all services in-process
over real mTLS), `npm run test:settlement` (five service processes and both worker
commands, fresh temporary install), the "Settlement" section of `npm run test:http`
(browser flow), `tests/db/transaction-schema.test.mjs` (v5 guards) and
`tests/setup/upgrade-7.test.mjs`.

| Threat / control | Test | Result | Date |
|--------|------|--------|------|
| Payment | Alice → Bob $12.50: approved, posted, `completed`; bank and `/wallet` (Identity → CBI) show **$487.50 / $262.50**; one debit + one credit sharing the bank posting reference; audit trail requested → approved → started → settled | Pass | 2026-10-19 |
| Bank enforcement | $600.00 with fraud passing → bank `insufficient_funds` → `failed`, nothing moved; recipient account frozen at the bank → `failed`; VaultPay wallet frozen after approval → Identity refuses → `failed`, no bank call | Pass | 2026-10-19 |
| 282 – idempotency | Bank answers after committing while CBI times out → `unknown`, transfer in flight; retry with the same key → original posting, one posting, money moved once (in-process and real processes); duplicate settlement message skipped | Pass | 2026-10-19 |
| Crash recovery | Worker gone after recording the attempt, and after the bank posted (real process killed): lease expires, next run completes with the same key, one posting | Pass | 2026-10-19 |
| Concurrency | 3 in-process workers and 3 worker processes × 6 transfers: each completed once, one posting each, balances exact, ledger balanced | Pass | 2026-10-19 |
| D5 / approvals | Approval with < 60 s left or genuinely expired → back to `pending_risk` + new `fraud_check`, re-approved, settled; a stored approval for another amount → re-screen, never posted; unknown outcome after approval expiry → `dead` / `needs_reconciliation`, still in flight | Pass | 2026-10-19 |
| Tokens | Identity: only `vaultpay-settlement`, only for a genuine unexpired approval, only two body fields; tampered/declined/expired approvals refused. CBI: body refused, Next.js refused, tampered, expired, wrong scope, wrong audience, other-certificate and same-account tokens refused; single use (replay `401`); settlement token cannot read balances | Pass | 2026-10-19 |
| Ledger | Debit/credit totals equal; posting without the settled bank reference, credit before debit, completing without both entries, UPDATE/DELETE all refused | Pass | 2026-10-19 |
| Leakage | `/wallet` and logs contain no bank account, posting reference, idempotency key, token or key | Pass | 2026-10-19 |

Step 8 tests (operations): `tests/services/reconciliation.test.mjs` (all services in-process
over real mTLS), `npm run test:reconcile` (real processes and the `reconcile` command), the
"Operations overview" section of `npm run test:http`, `tests/setup/upgrade-8.test.mjs`, and
static checks that `/operations` has no form, action or write statement.

| Threat / control | Test | Result | Date |
|--------|------|--------|------|
| Lost bank answer | Bank posted, CBI timed out → in flight; reconcile → completed with exactly one ledger pair and the original posting; Alice $487.50 / Bob $262.50 (real processes); repeated runs and the settlement worker change nothing | Pass | 2026-10-19 |
| Unknown outcome | CBI down or invalid lookup answers → `unresolved`, still in flight, funds reserved, never failed; CBI back → completed (real processes) | Pass | 2026-10-19 |
| No posting | Settlement unreachable → in flight; reconcile → failed, nothing moved, funds released; the key is never sent again; a live lease → `busy`, untouched | Pass | 2026-10-19 |
| Mismatch | Bank record with the same key but another amount → exception recorded once, left in flight, no ledger | Pass | 2026-10-19 |
| Concurrency | 3 reconcilers (separate connections) and 3 `reconcile` processes: each transfer resolved once, one ledger pair, one posting | Pass | 2026-10-19 |
| Expiry | Only overdue transfers without a settlement request expire; a leased one waits for the next pass; in-flight never expires; reservations released only on expiry | Pass | 2026-10-19 |
| Parked messages | Dead fraud/settlement messages listed on `/operations`; `--requeue-dead` (only with `--once`) retries a not-yet-sent transfer as a new message, once; in-flight not requeued | Pass | 2026-10-19 |
| Ledger integrity | Healthy ledger: no issues; an unbalanced pair is flagged and audited, nothing corrected; ledger/audit UPDATE/DELETE still refused | Pass | 2026-10-19 |
| Lookup tokens | Only `vaultpay-recon` (Settlement, Next.js refused); strict body; no body at CBI; records token cannot post; settlement token cannot look up; single use; no account in answers; lookups never post | Pass | 2026-10-19 |
| 244 / operations | `/operations`: support with MFA only (customer → access denied, password-only → MFA, signed out → login); one form (sign-out); every view audited, refused views not; no bank account, posting reference, key, token, wallet id, email or name | Pass | 2026-10-19 |
| Isolation | `recon.env` holds the Reconciliation certificate, `web.env` no longer does (upgrade test); Next.js imports no worker or service code | Pass | 2026-10-19 |

Step 9 regression tests (final review):

| Threat / control | Test | Result | Date |
|--------|------|--------|------|
| 282 / D76 | "No posting found" after 10 quiet minutes → still in flight and reserved, no decision recorded; the original request then reaches the bank → next pass completes it with one ledger pair; never `failed` in between | Pass | 2026-10-19 |
| 282 / D77 | Bank refusal received on a retry after an unanswered first send → stays in flight; later the same key settles once | Pass | 2026-10-19 |
| Invariant | Every `failed` transfer's key has no bank posting; every bank posting belongs to a completed transfer | Pass | 2026-10-19 |
| Real processes | `test:reconcile`: Settlement unreachable → "not found" → in flight and reserved (not failed); Settlement back → the same key settles it once | Pass | 2026-10-19 |

Final compliance review tests:

| Threat / control | Test | Result | Date |
|--------|------|--------|------|
| 121 | 30 confirmations per minute per customer are processed, the 31st refused before the balance flow or database is touched; other customers unaffected; window resets (`transfers.test.mjs`, HTTP "Transfer flood") | Pass | 2026-10-19 |
| 121 / 272 / 287 | Pending backlog bounded per wallet and in total; 30 concurrent writers on separate connections → exactly 20 accepted; repeats of accepted keys still answered | Pass | 2026-10-19 |
| 284 | Completed and failed transfers compared once with the bank (`matched`); a wrong posting reference, a "settled" the bank never posted and a "failed" the bank did post are all flagged `mismatched` + audited + shown as exceptions, not corrected; bank down → nothing recorded, retried | Pass | 2026-10-19 |

---

## 5. Phase status

| Phase | Work laptop | Home PC | Notes |
|-------|-------------|---------|-------|
| 0 – Environment & scaffold | Environment verified; repo created and pushed; Next.js 16.4.1 starter runs; lint passes | Configured 2026-10-18: Node 22.23.3 / npm 10.9.9; repo cloned at `C:\dev\vaultpay`; `npm ci` succeeded; `npm run lint` passes; `npm run dev` starts and the starter page loads; git status clean. Phase 0 dependencies installed; `npm run smoke` 33/33 pass; `npm run lint` passes; `npm run build` succeeds; `/api/health` returns `{"status":"ok"}` under `npm run start` (see below) | Both computers configured; Node 22 pinned (D13). Remaining: on the work laptop, `npm ci`, `npm run smoke`, `npm run build` and the `/api/health` check |
| 2 – Setup, databases, PKI, secrets, demo data | Pending (needs Phase 0 laptop steps, then `npm ci` + `npm run setup`) | Done 2026-10-18 (Sections A–C): `npm test` 123 tests – 122 pass, 0 fail, 1 skipped (file symlinks need Developer Mode); `npm run setup` on the existing install added only the mock Core Banking DB and demo data (keys and certificates kept); repeat run kept everything; `npm run setup:check` 11/11 PASS; `NODE_ENV=production` refused; lint, build, smoke test pass | Not yet: login/TOTP UI, transfer endpoints, Fraud/Settlement/CBI services (later steps). `/api/health` still uses an in-memory DB |
| 3 – Authentication, MFA, roles, KYC | Pending (`git pull`, `npm ci`, `npm run setup` migrates to identity v3 / transaction v2) | Done 2026-10-19 (Sections 3A–3F): `npm test` 218 tests – 217 pass, 0 fail, 1 skipped; `npm run test:http` 134/134; lint, build, smoke, setup, `setup:check` 11/11 PASS; production audit 0 vulnerabilities | Next: Step 4 (Core Banking Integration, balances) and Step 5 (transfers, which must call `requireVerifiedCustomer()` again just before creating a transfer) |
| 4 – Core Banking integration and balances | Pending (`git pull`, `npm ci`, `npm run setup` – upgrades the secrets layout and issues the new certificates) | Done 2026-10-19 (4A–4C): `npm test` 254 – 253 pass, 0 fail, 1 skipped; `test:http` 144/144 (twice); `test:services` 28/28; `test:mock-bank` 10/10; lint, build, smoke, setup, `setup:check` pass; home PC upgraded in place | Next: Step 5 (transfers) – see "Before Step 5" below |
| 5 – Transfer initiation | Pending (`git pull`, `npm ci`, `npm run setup` – migrates the transaction DB to v3) | Done 2026-10-19: `npm test` 269 – 268 pass, 0 fail, 1 skipped; `test:http` 170/170; `test:services` and `test:mock-bank` pass; lint, build, smoke, setup (v2 → v3 with backup), `setup:check` pass | Committed in `24364f4` (Steps 5–8 checkpoint). |
| 6 – Fraud screening | Pending (`git pull`, `npm ci`, `npm run setup` – adds fraud/orchestrator credentials, transaction DB v4) | Done 2026-10-19: `npm test` 281 – 280 pass, 0 fail, 1 skipped; `test:http` 178/178; `test:fraud` 13/13; `test:services`, `test:mock-bank`, lint, build, smoke, setup (v3 → v4, credentials upgraded in place), `setup:check` pass | Committed in `24364f4`. |
| 7 – Settlement and ledger | Pending (`git pull`, `npm ci`, `npm run setup` – adds the Settlement server certificate, Identity's decision public key, transaction DB v5, bank DB v2) | Done 2026-10-19: `npm test` 292 – 291 pass, 0 fail, 1 skipped; `test:http` 186/186; `test:settlement` 20/20; `test:fraud`, `test:services`, `test:mock-bank`, lint, build, smoke, setup (in place, backups, keys kept), `setup:check` pass | Committed in `24364f4`. |
| 8 – Operations, reconciliation, recovery | Pending (`git pull`, `npm ci`, `npm run setup` – moves the Reconciliation certificate to `recon.env`, transaction DB v6) | Done 2026-10-19: `npm test` 305 – 304 pass, 0 fail, 1 skipped; `test:http` 197/197; `test:reconcile` 17/17; `test:settlement`, `test:fraud`, `test:services`, `test:mock-bank`, lint, build, smoke, setup (in place, backups, keys kept), `setup:check` pass | Committed in `24364f4` (with the Step 9 review fixes D76/D77). |
| 9 – Final review, documentation, packaging | Pending (`git pull`; no setup change) | Done 2026-10-19: review fixes D76/D77 with regression tests; `npm test` 309 – 308 pass, 0 fail, 1 skipped; all real-process checks pass; README, demo checklist; submission ZIP built with `git archive` and scanned (D11) | Steps 5–8 committed and pushed as `24364f4`; documentation in a separate final commit |
| 10 – Final compliance review | Pending (`git pull`; no setup change) | Done 2026-10-19: originals located (Assignment 4 list, Assignment 5 architecture, Project 2 instructions); D78/D79 implemented; `npm test` 315 – 314 pass, 0 fail, 1 skipped; all real-process checks pass; README rebuilt to the Project 2 deliverable list | Final commit and `Marquez_Project2_Source.zip` |

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

### Step 5 – transfer initiation (home PC, 2026-10-19)

**Design.** `/send` (eligible customers only) → client form → one Server Action
(`app/send/actions.js`): `assertSameOrigin` → `requireVerifiedCustomer()` →
`reviewTransfer` (validate, issue idempotency key) or `initiateTransfer`
(`lib/server/transfer-initiation.js`): eligibility again → key/amount/recipient format →
source wallet must equal the server's → recipient lookup → stored-key replay → balance via
Identity/CBI (fail closed) → eligibility, source wallet and recipient once more,
synchronously → `transferWriter().create()` (`lib/server/transfer-orchestrator.js`, D47–D50).
Money is integer cents (`lib/server/money.js`). Migration `transaction/0003` registers
`transfer.requested`; nothing else in the schema changed.

**State transitions** (unchanged trigger from migration 0001, mirrored in code):
`pending_risk → pending_settlement | declined | expired`;
`pending_settlement → settlement_in_flight | pending_risk | expired`;
`settlement_in_flight → completed | failed`. Step 5 only inserts `pending_risk`.

**End to end (real processes):** Alice reviews $12.50 to `bob@example.test`, confirms →
"Transfer submitted – Pending – security check"; `/wallet` lists it with
`Pending outgoing $28.00` (seeded test transfer included); resubmitting returns the same
transfer; Carol, support and password-only sessions are refused; with the bank stopped the
transfer is refused with "We cannot check your balance right now".

**Remaining limitations**

- Transfers stay `pending_risk`: no fraud worker consumes the outbox yet (Step 6), no
  settlement (Step 7), and no job expires transfers after `pending_expires_at` – expired
  but unmarked transfers keep holding funds (conservative).
- The funds check is preliminary; Core Banking must enforce funds at posting.
- A customer whose oldest wallet is not active cannot send (the balance flow uses the
  oldest wallet; fails closed rather than using another wallet's balance).
- Recipients are identified by email only (no merchant/QR payments, no recipient name at
  confirmation); the history shows counterparties by wallet id.
- The idempotency key protects retries of one confirmation; re-reviewing creates a new
  intended transfer (by design).
- The transfer writer is narrow by API and triggers, not database permissions (D3).
- The confirmation step needs JavaScript for a normal browser flow (Flight data, as in Step 3).

**Before Step 6:** an outbox worker that leases `fraud_check` messages (`lease_until`,
`attempts`), calls Fraud & Risk Check over mTLS, stores the signed decision and moves
`pending_risk → pending_settlement | declined` in one transaction; an expiry job; audit
event types for those transitions (new migration).

### Step 6 – fraud screening (home PC, 2026-10-19)

**Design.** `services/fraud/` (Fraud & Risk, D54) signs decisions from the deterministic
engine (`lib/fraud/engine.js`, D58) with `lib/fraud/risk-decision.js` (D56).
`services/orchestrator/fraud-worker.js` (`npm run fraud-worker [-- --once]`, D55) runs
`lib/orchestrator/fraud-worker.js`: claim (lease) → skip if not `pending_risk` → request
with the DB row → verify → fenced apply (D57, D59). Migration `transaction/0004`
registers `transfer.risk_approved`, `transfer.risk_declined`, `risk.decision_rejected`.

**Transitions used:** `pending_risk → pending_settlement` (approve) and
`pending_risk → declined` (decline); both already allowed by the 0001 trigger.

**Demo (verified by `test:http`, real processes):** Alice sends $12.50 and $300.00 to Bob →
both *Pending – security check*; `fraud-worker --once` prints `pending_settlement=2
declined=1` (with the earlier $3.00 test transfer) → `/wallet` shows *Pending – awaiting
settlement* and *Declined*; the pending outgoing total drops the declined amount.

**Remaining limitations**

- No settlement yet: approved transfers wait in `pending_settlement` with a pending
  `settlement` outbox message; decisions expire after 10 minutes, so Step 7 must check
  `expires_at` and re-screen (`pending_settlement → pending_risk`) when it is past.
- No expiry job: transfers past `pending_expires_at` (and `dead` messages) stay pending and
  keep holding funds until a later step expires them.
- The engine sees only the transfer itself (no velocity, history or device signals);
  the Step 2 mock-scoring vendor key and Fraud's service-token public key are unused.
- The worker is started by hand; there is no supervisor or alerting for `dead` messages.
- Lease length (30 s) is longer than one Fraud call (3 s deadline); a worker blocked longer
  than that loses its lease and is fenced out (safe, but its work is repeated).
- The narrow-writer guarantee is by API and triggers, not database permissions (D3).

### Step 7 – settlement, bank posting and ledger (home PC, 2026-10-19)

**Design.** `services/settlement/` (D61) ← `services/orchestrator/settlement-worker.js`
(`npm run settlement-worker [-- --once]`) running `lib/orchestrator/settlement-worker.js`;
Identity settlement tokens (D62); CBI `POST /v1/postings` (D63); bank postings (D64);
outcomes (D65, D66); schema guards (D67). Full flow: docs/SERVICE_AUTH.md section 3c.

**Transitions used:** `pending_settlement → settlement_in_flight → completed | failed`, and
`pending_settlement → pending_risk` for an expired approval (all allowed by the 0001
trigger; 0005 adds the evidence requirements for `completed` and `failed`).

**End-to-end result (fresh temporary install, real processes):** Alice $500.00 → sends
$12.50 → fraud `pending_settlement` → settlement `completed` → Alice **$487.50**, Bob
**$262.50** at the bank and on `/wallet`; ledger debit/credit $12.50 each with the bank's
posting reference. The browser flow in `test:http` settles $12.50 + $3.00 → Alice $484.50,
Bob $265.50, *Completed*; the $300.00 transfer stays *Declined*.

**Remaining limitations**

- Unknown outcomes that outlive the approval are parked (`needs_reconciliation`) – there is
  no reconciliation job or dashboard yet (Step 8).
- No expiry job for `pending_risk`/`pending_settlement` transfers past `pending_expires_at`.
- The CBI replay cache is in memory per process; the bank's idempotency key is what makes a
  replayed settlement token harmless after a CBI restart.
- Refusals are not stored at the bank; merchants can be credited by the code path but no UI
  creates merchant payments.
- A holder of Settlement's credentials plus an approval could post with its own key once
  (the bank then holds a posting the Orchestrator does not know) – reconciliation must
  detect it.
- Workers and services are started by hand; no supervisor, alerting or metrics.
- Narrow writers by API and triggers, not database permissions (D3).

### Step 8 – operations, reconciliation and recovery (home PC, 2026-10-19)

**Design.** `services/orchestrator/reconcile.js` (`npm run reconcile [-- --once [--requeue-dead]]`)
runs `lib/orchestrator/reconciliation.js` (expire → requeue on request → reconcile →
ledger check) with `recon.env` (D69); bank lookup via Identity + CBI (D70, D71);
exceptions and integrity (D72); expiry and requeue (D73); `/operations` with
`lib/server/operations.js` (D74). Migration `transaction/0006` registers the new audit event
types; reconciliation decisions use the existing append-only `reconciliation_result` table.

**End-to-end recovery (real processes, `test:reconcile`):** a bank that posts but answers too
late leaves Alice's $12.50 *Processing*; `reconcile --once` finds the original posting →
*Completed*, one ledger pair, Alice $487.50 / Bob $262.50, one posting. With CBI down the
transfer stays unresolved and reserved; once CBI is back it completes. A request that never
reached the bank was reconciled to *Failed* with nothing moved and the reservation released
(**changed in Step 9, D76:** it now stays unresolved and reserved until the posting appears or
an operator resolves it).
Three concurrent `reconcile` processes resolve three transfers exactly once. An overdue
transfer expires; a parked fraud check is retried only with `--requeue-dead`.

**Security findings (this step)**

- Next.js no longer lists the Reconciliation certificate (it was in `web.env` since Step 2,
  unused) – moved to `recon.env`.
- Next renders server pages twice per full load (also `/wallet`'s balance call): side
  effects in page rendering must be idempotent; the operations view audit is de-duplicated.
- No other issue found reviewing the lookup path, expiry and requeue against leases/fencing.

**Remaining limitations**

- Reconciliation does not re-verify *completed* transfers against bank postings (only open
  outcomes); a posting made outside VaultPay with an unknown key (D61 limitation) is not found.
- Mismatches and parked in-flight settlements need a human: there is no resolution workflow.
- Recovery is a command on the server, not in the UI (by design); no scheduler, alerting or
  metrics; the loop mode must be started by hand.
- Expired transfers are detected only when `reconcile` runs.
- The 2-minute minimum age assumes no worker blocks longer than its timeouts (12 s) without
  losing its lease; a paused process holding a live lease is waited for, not overridden.
- View de-duplication is in memory per Next.js process.

### Step 9 – final review, documentation and packaging (home PC, 2026-10-19)

**Lifecycle review.** Login + MFA, KYC and wallet authorization, transfer initiation and
idempotency, fraud decisions, settlement and bank idempotency, the ledger, reconciliation and
the operations view were re-read against the threat requirements and the tests.

**Reconciliation safety question – "under exactly which conditions does 'no posting found'
fail a transfer?"** Before this step: transfer in flight, open attempt older than 2 minutes,
no outbox message leased (even expired), no settlement-message activity for 2 minutes, bank
lookup `not_found`. **Not authoritative:** a released lease only means the worker stopped
waiting. A request already handed to the bank can still commit later – CBI gives up after
3 s, but the bank commits when it obtains its SQLite write lock (busy timeout up to 5 s) or
after any pause of the bank process – so a `failed` transfer could later be debited with no
ledger entry. The same race existed for a bank *refusal* received on a retry after an
unanswered first send. **Fix (D76, D77):** a missing posting never fails a transfer (left
unresolved, funds reserved; completed if the posting appears); a refusal fails only a
first-and-only send. Regression tests race a late posting with reconciliation and a refusal
with an earlier send; an invariant test checks that no `failed` transfer has a bank posting.

**Leak review.** `/wallet`, `/send`, `/support`, `/operations`, outage pages, worker and
service logs: no token, key, credential, bank account reference or internal error (HTTP and
real-process checks assert it).

**No other critical defect found.** Remaining limitations are listed in the README.

**How the AI was used (whole project).** Work went step by step: for each step I gave the
requirements and constraints, the AI inspected the code and docs, proposed or implemented
the design, ran every test command on the home PC (Node 22 put first on `PATH`), and stopped
for my approval; I approved, corrected or rejected (see the "My response" column in
section 1). Corrections of mine that changed the design include: no signing key in Next.js
(D43), no generic token endpoint and no caller-chosen bank accounts (D44, D62), MFA marker
per session rather than "TOTP enrolled" (Step 3), read-only support with a separate audit
writer, and keeping ambiguous transfers unresolved rather than failed (D76). Problems the AI
introduced or missed and later fixed are in section 3 (e.g. DNS rebinding, TOTP replay,
the build tracing `data/`, flaky timing in settlement tests, the D76 race). Commits and
pushes happened only when I asked.

**Submission package.** Built from the committed tree with `git archive` (tracked files
only: no `node_modules`, `.next`, `.git`, `data/`, databases, env files, certificates, keys,
backups or test artifacts) and scanned for key material before handing over (D11). The ZIP
was then installed and tested as a grader would: extracted to an empty folder, `npm ci
--ignore-scripts` (see Problems), lint, `npm test` (307 pass, 2 skipped), setup,
`setup:check`, build, `test:http`, `test:settlement`, `test:reconcile` – all pass.

### Final compliance review (home PC, 2026-10-19)

**Original specifications used** (outside the repository, on this computer): Project 2
instructions (`Downloads\Project 2.docx`), Assignment 4 submission (`Documents\SSD\A_A_4\Assignment 4_Amarquez.docx`
– the 15 prioritized threats), Assignment 5 architecture (`Downloads\VaultPay_Architecture.docx`
and `VaultPay_Assignment5_Presentation.pptx`), Project 1 (`Documents\SSD\P1\`). Until this
review the implementation had been checked against this log's summary of the design; the
review compared the code with the original documents.

**Findings.** All 15 Assignment 4 threats have an implemented, tested control; two primary
controls named in Assignment 5 were missing and are now implemented (D78 for 121, D79 for
284). Architecture differences that remain (single Next.js app for customers and support, no
WAF/shared-store limiter/KMS/sandbox/replication/circuit breaker, no QR and KYC onboarding
screens, SQLite file checks instead of TLS to a database server) are listed with reasons in
the README.

**Documentation.** README rebuilt to the Project 2 deliverable list (summary, prerequisites,
install/run, configuration, accounts, threat-to-control mapping with files, functions and
tests, Assignment 5 fidelity, deviations, limitations, dependency inventory);
`docs/PRESENTATION_PREP.md` added; SETUP, SERVICE_AUTH and DEMO_CHECKLIST aligned.

# VaultPay

**Project 2: Secure Application Development with AI Pair Programming** – Alejandro Marquez,
Secure Software Development.

VaultPay is a **localhost-only** peer-to-peer wallet built from my Project 1 threat model
(STRIDE, DFD Levels 0–2), my Assignment 4 prioritized threats (top 15, DREAD) and my
Assignment 5 architecture ("VaultPay – Next.js Threat-Mitigation Architecture").
Customers sign in with a password and TOTP and send money to each other; every transfer is
screened by a Fraud & Risk service that signs its decision, settled exactly once at a
(mock) partner bank through an isolated Core Banking Integration service, recorded in a
double-entry ledger, and reconciled against the bank's records. Support staff get a
read-only, audited view.

**Stack:** Node.js 22 · SQLite (better-sqlite3) · Next.js 16 · React 19 – plus the
libraries listed under [Third-party dependencies](#third-party-dependencies).

> [!WARNING]
> Localhost demonstration only. Setup creates demo accounts with **published, demo-only
> passwords** and generates every key and certificate locally. Never reuse the passwords
> and never expose the application beyond your own computer. Every process listens on
> `127.0.0.1` only. The repository contains **no secrets**.

Contents: [Summary](#system-summary) · [Prerequisites](#prerequisites-and-versions) ·
[Install and run](#installation-and-run-step-by-step) · [Configuration](#configuration-environment-database-seed-data) ·
[Accounts](#demo-and-test-accounts) · [Demo](#demonstration) · [Threat-to-control mapping](#threat-to-control-mapping-assignment-4) ·
[Architecture](#how-the-implementation-follows-assignment-5) · [Deviations](#deviations-from-assignment-5-documented-and-justified) ·
[Limitations](#known-limitations) · [Dependencies](#third-party-dependencies) · [Tests](#tests) · [Documentation](#further-documentation)

## System summary

```
Browser ──HTTP 127.0.0.1:3000 (session cookie only)──► Next.js "web" (customer app + read-only support/ops views)
   │                                                     DAL guards · Server Actions · Orchestrator transfer writer
   │ mTLS vaultpay-web            │ mTLS vaultpay-web + single-use service token
   ▼                              ▼
Identity (4200) ─ issues tokens ─► Core Banking Integration "CBI" (4300) ─ mTLS + credential ─► mock Core Banking (4100)
 only holder of the token key      only path to the bank, only holder of its credential            balances + postings
   ▲                              ▲
Settlement (4500) ◄─ mTLS ─ settlement worker ┐
Fraud & Risk (4400) ◄─ mTLS ─ fraud worker    ├─ Orchestrator outbox workers (transaction DB)
 only holder of the decision key              │
                     reconciliation (recon) ──┘─ read-only bank lookups via Identity + CBI
```

| Process | Command | Port | Role |
|---------|---------|------|------|
| Next.js web | `npm run dev` / `npm run start` | 3000 | Customer pages (`/wallet`, `/send`), support (`/support`), operations (`/operations`); every check on the server |
| Identity | `npm run identity` | 4200 | Sole issuer of service tokens (balance, settlement, reconciliation lookup) |
| Core Banking Integration (CBI) | `npm run cbi` | 4300 | Sole path to the bank; forwards only what a token names |
| mock Core Banking | `npm run mock-bank` | 4100 | Stand-in for the partner bank: balances, idempotent postings |
| Fraud & Risk | `npm run fraud` | 4400 | Deterministic screening; signs approve/decline decisions |
| Settlement | `npm run settlement` | 4500 | Verifies the approval, obtains a one-posting token, posts through CBI |
| Fraud worker | `npm run fraud-worker` | – | Orchestrator: consumes `fraud_check` outbox messages |
| Settlement worker | `npm run settlement-worker` | – | Orchestrator: consumes `settlement` outbox messages |
| Reconciliation | `npm run reconcile` | – | Reconciliation & Audit: ambiguous outcomes, bank comparison, expiry, ledger check |

`npm run services` starts the five services together.

**Payment lifecycle:** sign in + TOTP → `/send` (review, confirm; server re-checks session,
MFA, KYC, wallet, recipient, amount, rate limit, funds) → transfer `pending_risk` + audit +
outbox in one transaction → fraud worker: signed decision → `pending_settlement` or
`declined` → settlement worker: attempt recorded, one-posting token, bank posts atomically and
idempotently → `completed` + one ledger debit and credit (or `failed` on a definitive
first-send refusal; unknown outcomes stay in flight) → reconciliation compares with the bank.

## Prerequisites and versions

| Requirement | Version |
|-------------|---------|
| Windows | 10 or 11 (developed and tested on Windows 11) |
| Node.js | **22.23.3** (`.nvmrc`; `package.json` requires 22.x; services refuse other majors) |
| npm | 10.9.9 (ships with Node 22.23.3) |
| Git | optional (only to clone; the ZIP works without it) |
| Authenticator app | any TOTP app (Google/Microsoft Authenticator, 1Password, …) |
| Free ports | 3000, 4100–4500 on 127.0.0.1 |

No database server, cloud account or internet access is needed at run time.

## Installation and run (step by step)

PowerShell, in the extracted project folder (`npm.cmd` because PowerShell may block `npm.ps1`):

```powershell
node -v                      # must print v22.23.3 (activate Node 22 first if not)
npm.cmd ci                   # exact dependency versions from package-lock.json
npm.cmd run setup            # creates data/: 3 databases, dev CA + certificates, per-process secrets, demo data
npm.cmd run setup:check      # read-only verification – every line PASS, "Installation check passed"
npm.cmd run build
npm.cmd run services         # terminal 1: mock bank, Identity, CBI, Fraud & Risk, Settlement (Ctrl+C stops all)
npm.cmd run start            # terminal 2: http://localhost:3000   (or: npm.cmd run dev)
```

**If `npm ci` stops at `better-sqlite3` with `gyp ERR! find VS … Could not find any Visual
Studio installation`:** `npm ci` tries to compile it from source although the package ships a
prebuilt Windows binary (`prebuilds/win32-x64.node`). Run `npm.cmd ci --ignore-scripts`
instead – no dependency needs an install script on Windows (verified on a fresh copy of the
submission: lint, all tests and the real-process checks pass). Installing the Visual Studio
C++ Build Tools also works.

Process the transfers (terminal 3, any time):

```powershell
npm.cmd run fraud-worker -- --once        # screen submitted transfers  (omit --once to keep running)
npm.cmd run settlement-worker -- --once   # settle approved transfers
npm.cmd run reconcile -- --once           # reconcile, compare with the bank, expire overdue, check the ledger
```

Without the services the app still works: balances show "temporarily unavailable" and
transfers wait (fail closed). Full platform notes and troubleshooting:
[docs/SETUP.md](docs/SETUP.md).

## Configuration (environment, database, seed data)

**No manual configuration is required.** `npm run setup` generates everything under the
git-ignored `data/` folder (excluded from the ZIP):

| Item | Where | Notes |
|------|-------|-------|
| Databases | `data/db/identity.db`, `transaction.db`, `mock-core-banking.db` | SQLite, STRICT tables, versioned checksummed migrations in `lib/server/db/migrations/` (identity v3, transaction v6, mock bank v2) |
| Certificates | `data/pki/` | Development CA + one certificate per service identity (P-256, 1 year) |
| Secrets | `data/secrets/<process>.env` | One file per process (`web`, `identity`, `cbi`, `fraud`, `settlement`, `orchestrator`, `recon`, `mock-core-banking`, `mock-fraud-scoring`), random values generated per computer; each process loads only its own file |
| Seed data | identity + mock bank DBs | Demo customers, support user, merchant, bank accounts with opening balances |

Setup is safe to repeat (creates only what is missing; backs up and migrates outdated
databases; never resets data without an explicit `--reset-db` and typed confirmation).

Optional **environment variables** (development/demo settings, none secret):

| Variable | Default | Purpose |
|----------|---------|---------|
| `VAULTPAY_DATA_DIR` | `./data` | Use another installation folder (all tests use temporary ones) |
| `VAULTPAY_IDENTITY_PORT`, `VAULTPAY_CBI_PORT`, `VAULTPAY_MOCK_BANK_PORT`, `VAULTPAY_FRAUD_PORT`, `VAULTPAY_SETTLEMENT_PORT` | 4200, 4300, 4100, 4400, 4500 | Service ports |
| `VAULTPAY_FRAUD_DECLINE_AT_CENTS` | `25000` | Fraud demo threshold (decline at ≥ $250.00) |
| `VAULTPAY_FRAUD_BLOCKED_PAYEES` | – | Comma-separated wallet ids the fraud engine always declines |
| `VAULTPAY_MOCK_BANK_POST_DELAY_MS` | `0` | Fault injection: the mock bank answers postings late (after committing) |
| `VAULTPAY_SETTLEMENT_LEASE_MS` | `60000` | Shorter worker lease to demonstrate crash recovery |
| `VAULTPAY_RECONCILE_MIN_AGE_MS` | `120000` | How old an open outcome must be before reconciliation looks at it |

## Demo and test accounts

| Login | Password | Role | KYC | Opening balance |
|-------|----------|------|-----|-----------------|
| `alice@example.test` | `VaultPayDemo-Alice-1!` | Customer | Approved | $500.00 |
| `bob@example.test` | `VaultPayDemo-Bob-1!` | Customer | Approved | $250.00 |
| `carol@example.test` | `VaultPayDemo-Carol-1!` | Customer | **Pending** – cannot send | $100.00 |
| `support@example.test` | `VaultPayDemo-Support-1!` | Ops, `support_readonly` | – | – |

Merchant: Demo Coffee (`mer_demo_coffee`, $0.00). Every account enrols TOTP (QR code or
manual key) on its **first** sign-in and must enter a code on every later sign-in; backup
codes are shown once. These are published demo values for localhost only.

## Demonstration

Step-by-step commands with expected results: **[docs/DEMO_CHECKLIST.md](docs/DEMO_CHECKLIST.md)**
(Alice → Bob $12.50 → fraud approval → settlement → $487.50 / $262.50 → $300.00 declined →
support `/operations` → reconciliation of a lost bank answer). Automated equivalents:
`npm run test:settlement`, `npm run test:reconcile`, `npm run test:http`.

## Threat-to-control mapping (Assignment 4)

All 15 prioritized threats from my Assignment 4 submission ("Top 15 – Prioritized Threats
for VaultPay", DREAD), with the primary mitigating component named in Assignment 5.
Paths are relative to the project root; tests run with the commands in [Tests](#tests).

| Rank | ID | Band (avg) | Threat (Assignment 4) | Mitigation implemented | Where in the code | Tests proving it | Remaining gap |
|---|---|---|---|---|---|---|---|
| 1 | 121 | Critical (7.6) | Transaction request flood exhausts Ledger or Transaction DB | Per-account limit on transfer confirmations (30/min) checked before any work; pending-backlog limits (20 per wallet, 2,000 total) inside the write transaction; DB idempotency (retries add nothing); amount limits; preliminary funds check bounds pending value; login/MFA limits; small request bodies; early "try again later" | `lib/server/rate-limit.js` → `createTransferRateLimiter`, `createLoginRateLimiter`; `lib/server/transfer-initiation.js` → `initiateTransfer`; `lib/server/transfer-orchestrator.js` → `createTransferWriter` (`MAX_PENDING_PER_WALLET`, `MAX_PENDING_TOTAL`, `UNIQUE(sender_wallet_id, idempotency_key)`); `app/send/actions.js` → `transferAction`; `services/common/https-service.js` → `readJsonBody` | `tests/app/transfers.test.mjs`: "threat 121: transfer confirmations are rate-limited…", "threats 121/272/287: a pending backlog is bounded…", idempotency tests; `tests/app/rate-limit.test.mjs`; `npm run test:http` "Transfer flood (threat 121)", "Rate limiting" | No WAF, no shared-store limiter (single local instance; limits are in memory per process) |
| 2 | 272 | Critical (7.6) | Fraud & Risk Check outage prevents transfers from completing screening | Transfers stay `pending_risk` (never approved by default); durable outbox with leases, exponential backoff, parking after 10 attempts; expiry after the pending window; backlog limits | `lib/orchestrator/fraud-worker.js` → `createFraudWorker` (`claimNext`, `process`, `retry`); `lib/orchestrator/reconciliation.js` → `expireOverdue`, `requeueParked`; `lib/server/transfer-orchestrator.js` (backlog) | `tests/services/fraud.test.mjs`: "Fraud & Risk unavailable…", "after MAX_ATTEMPTS the message is dead…"; `npm run test:fraud` "Outage and recovery"; `tests/services/reconciliation.test.mjs` expiry test | Backoff instead of a circuit breaker; no customer notification beyond the status on `/wallet`; one Fraud instance (no redundancy) |
| 3 | 287 | Critical (7.6) | Settlement outage prevents transfers from completing settlement | Approved transfers wait (`pending_settlement` / `settlement_in_flight`); retries with backoff and the SAME bank idempotency key; unknown outcomes never guessed; reconciliation resolves parked ones | `lib/orchestrator/settlement-worker.js` → `createSettlementWorker`; `lib/orchestrator/reconciliation.js` → `reconcile` | `tests/services/settlement.test.mjs`: "Settlement or CBI unavailable…"; `npm run test:reconcile` "No posting at the bank" (Settlement unreachable) | As 272 (backoff, no circuit breaker) |
| 4 | 282 | High (7.2) | Interrupted settlement request prevents transfers reaching Core Banking | Attempt recorded before sending; hard deadlines (3 s CBI→bank, 6 s, 12 s); bank-side idempotency key checked first with payload comparison (original result for a repeat, 409 on a different payload); retry/reconcile with the same key; a refusal fails a transfer only for a first-and-only send | `lib/cbi/core-banking-client.js` → `postTransfer`; `services/mock-core-banking/app.js` → `post` transaction; `lib/orchestrator/settlement-worker.js` → `start`, `process`; `lib/orchestrator/reconciliation.js` → `reconcile` | `tests/services/settlement.test.mjs`: "bank timeout AFTER posting…", "a worker that crashes before or after the bank call…", "regression (Step 9): a bank refusal after an earlier unanswered send…"; `tests/services/reconciliation.test.mjs` "bank posted but the answer was lost…", "regression (Step 9): the original posting arrives AFTER…"; `npm run test:settlement`, `npm run test:reconcile` | Ambiguous outcomes that never resolve need a person (funds stay reserved) |
| 5 | 307 | High (7.2) | Interrupted database write prevents transaction records being stored | Transactional outbox: transfer + audit + outbox in one SQLite transaction; every worker state change (decision, status, ledger, audit, outbox) in one `BEGIN IMMEDIATE` transaction; fenced leases; schema guards (completion needs ledger pair) | `lib/server/transfer-orchestrator.js` → `create`; `lib/orchestrator/fraud-worker.js` → `apply`; `lib/orchestrator/settlement-worker.js` → `complete`, `fail`; `lib/server/db/migrations/transaction/0001_initial.sql`, `0005_settlement.sql` | `tests/app/transfers.test.mjs` "database errors: nothing is half-written…"; `tests/services/fraud.test.mjs` "a crashed worker's lease expires…" (crash inside apply); `tests/services/settlement.test.mjs` crash test | No replication (single SQLite file; WAL) |
| 6 | 220 | High (7.0) | Malicious input executes code in the Core Banking Integration Adapter | CBI accepts no posting body – details come only from the signed token; strict schema checks of every claim and of every bank response (zod, `.strict()`); small body/header limits and timeouts; no `eval`, dynamic code or unsafe deserialization; generic errors | `services/cbi/app.js` → `posting`, `lookup`, `balance`, `tokenClaims`; `lib/cbi/core-banking-client.js` (`Balance`, `Posted`, `PostingRecord` schemas); `services/common/https-service.js` → `createServiceServer`, `readJsonBody` | `tests/services/balance-flow.test.mjs` "CBI refuses missing, expired, wrong-audience, wrong-scope, forged and over-long tokens", "an oversized request body is cut off…"; `tests/services/settlement.test.mjs` "settlement tokens…" (body refused); `tests/services/mock-core-banking.test.mjs` | No OS-level sandbox (non-root account, egress filtering) on a localhost demo |
| 7 | 274 | High (7.0) | Malicious risk response executes code in the Fraud & Risk Check | Fraud & Risk validates every request against a strict schema (400, nothing signed); the worker treats Fraud's answer as untrusted: Ed25519 signature, header, claims schema (`.strict()`), binding to the DB row and request id before use | `services/fraud/app.js` → `ScreeningRequest`, `createFraudServer`; `lib/fraud/risk-decision.js` → `verifyRiskDecision` (`DecisionClaims`); `lib/orchestrator/fraud-worker.js` → `process` | `tests/services/fraud.test.mjs`: "decisions verify only with the right key…", "the Fraud & Risk service answers only the Orchestrator's certificate and only valid requests", "tampered, replayed, mismatched and expired decisions are never applied" | No external scoring vendor (deterministic built-in rules), so the vendor-response path of the design is not exercised |
| 8 | 280 | High (7.0) | Spoofed Core Banking Integration Adapter receives a fraudulent settlement request | Mutual TLS everywhere: client verifies the server against the dev CA, localhost SAN and an exact expected CN; servers accept only allow-listed client CNs; service tokens bound to the caller's certificate (`cnf`), single use | `lib/services/mtls-request.js` → `mtlsRequest` (`expectedServer`); `services/common/https-service.js` → `createServiceServer` (`allowedClients`); `lib/services/service-token.js` → `verifyServiceToken` | `tests/setup/pki.test.mjs` "mTLS: a client refuses a CBI endpoint it cannot verify (spoofed adapter, threat 280)"; `tests/services/balance-flow.test.mjs` "caller identity and certificate binding are enforced"; `tests/services/fraud.test.mjs` (server identity pinned) | Development CA on the same computer (no hardware-protected keys) |
| 9 | 289 | High (7.0) | Malicious settlement response executes code in the Settlement Process | Settlement validates Identity's and CBI's answers strictly (status, outcome enum, posting-ref format, token claims match the transfer); the worker accepts only known outcomes and a valid posting ref, everything else = unknown | `services/settlement/app.js` → `settle`; `lib/orchestrator/settlement-worker.js` → `process`; `lib/cbi/core-banking-client.js` → `Posted` | `tests/services/settlement.test.mjs` "Settlement or CBI unavailable…" (200 without a decision / error statuses = unknown); `tests/services/reconciliation.test.mjs` "threat 284: a tampered settlement result is detected…" | As 220 (no OS sandbox) |
| 10 | 305 | High (7.0) | Spoofed Transaction Database receives transaction records | SQLite is an embedded file, so the design's "verified TLS to a private endpoint" becomes a safe open: path inside the data dir, no links/junctions, `application_id`, `db_meta` role and install id, full schema fingerprint and version check, integrity check; per-user ACLs on `data/` | `lib/server/db/open.js` (safe open), `lib/server/db/definitions.js`, `lib/server/db/migrations.js`; `scripts/setup/acl.mjs` | `tests/db/open.test.mjs` ("the identity database cannot be opened as the transaction database", "a changed db_meta role is refused…", tampered schema tests); `tests/db/migrations.test.mjs` | An administrator or malware running as the same user can still replace files (documented D4) |
| 11 | 120 | High (6.8) | Malicious transaction data alters records written to the Transaction DB | Sender, source wallet and balance derived on the server (never from the browser); strict input parsing (integer cents, schemas); parameterized queries only; one narrow writer per role; triggers: append-only ledger/audit/decisions, valid status transitions, immutable parties/amounts, ledger postings must match the transfer and its bank posting | `lib/server/transfer-initiation.js` → `initiateTransfer`, `reviewTransfer`; `lib/server/money.js` → `parseUsdToCents`; `lib/server/transfer-orchestrator.js`; `lib/server/db/migrations/transaction/0001_initial.sql`, `0005_settlement.sql` | `tests/app/transfers.test.mjs` (invalid amounts, tampered fields, source wallet, state machine vs trigger); `tests/db/transaction-schema.test.mjs`; `tests/app/security-invariants.test.mjs` "only the audit writer and the transfer writer open writable transaction DB connections…" | SQLite has no per-connection roles: narrow writers are enforced by module APIs and triggers (D3) |
| 12 | 284 | High (6.8) | Tampered settlement result causes an incorrect transfer outcome | Worker validates the outcome; completion requires a settled attempt with the bank posting ref and a balanced ledger pair (triggers); **Reconciliation & Audit compares every completed/failed transfer with the bank's own record** (read-only lookup) – mismatches are recorded and alerted, never auto-corrected | `lib/orchestrator/reconciliation.js` → `verifyFinished`, `reconcile`; `services/cbi/app.js` → `lookup`; `services/identity/app.js` → `reconciliationToken`; `lib/server/db/migrations/transaction/0005_settlement.sql`; `lib/server/operations.js` (exceptions) | `tests/services/reconciliation.test.mjs`: "threat 284: completed and failed transfers are compared with the bank once…", "threat 284: a tampered settlement result is detected – wrong posting reference, a 'settled' the bank never posted, a 'failed' the bank did post", "…bank path is down records nothing…"; `npm run test:reconcile` | Comparison runs when `npm run reconcile` runs (no scheduler); resolution of exceptions is manual |
| 13 | 82 | High (6.6) | Manipulated fraud/risk screening lets a fraudulent transfer reach settlement | Only Fraud & Risk holds the Ed25519 decision key; decisions bound to transfer id, parties, amount, currency, screening request, expiry and a unique id; verified by the worker, re-verified by Settlement AND by Identity before a settlement token exists; expired approvals go back to screening | `lib/fraud/risk-decision.js` → `signRiskDecision`, `verifyRiskDecision`; `services/settlement/app.js` → `settle`; `services/identity/app.js` → `settlementToken`; `lib/orchestrator/settlement-worker.js` (`rescreen`) | `tests/services/fraud.test.mjs` (forged/tampered/replayed/expired/misbound); `tests/services/settlement.test.mjs` "an expiring or expired fraud approval…", "a stored approval that no longer verifies (tampered)…", "settlement tokens…" (declined/tampered approvals refused); `tests/setup/secrets.test.mjs` (only `fraud.env` holds the signing key) | Key rotation is manual (`npm run setup -- --rotate-secrets`) |
| 14 | 244 | High (6.6) | Malicious input executes code in the Support / Ops Portal | Support is read-only end to end: role + MFA checked on every request, read-only DB connections, masked fields, every search/view audited before data is shown (fail closed), no forms or actions on `/operations`, no write path; React escaping, strict input normalization | `app/support/actions.js` → `lookupAction`; `lib/server/support.js` → `lookupCustomer`; `lib/server/operations.js` → `getOperationsOverview`; `app/operations/page.js`; `lib/server/audit.js` → `createAuditWriter`; `lib/server/dal.js` → `assertSupport`; `lib/server/session.js` (read-only connections) | `tests/app/wallet-support.test.mjs` ("support has no write path…", "every search and view is audited…"); `tests/app/roles.test.mjs`; `tests/services/reconciliation.test.mjs` "operations overview: support only…"; `tests/app/security-invariants.test.mjs` "Step 8: the operations page is read-only…"; `npm run test:http` support/operations sections | Same Next.js app as the customer pages (not a separate deployment); TOTP instead of SSO |
| 15 | 85 | High (6.4) | Spoofed Core Banking System sends false account or balance information | CBI pins the bank's certificate CN and validates every answer (zod `.strict()`, account must match the request); Next.js re-validates CBI's balance answer and the wallet id; the bank authenticates CBI (CN allowlist + credential); reconciliation detects disagreement | `lib/cbi/core-banking-client.js` → `createCoreBankingClient` (`EXPECTED_SERVER_CN`, `Balance`); `lib/server/balance.js` → `fetchCustomerBalance` (`CbiBalance`); `services/mock-core-banking/app.js` | `tests/services/mock-core-banking.test.mjs` ("a VaultPay certificate that is not the bank…", "other VaultPay services (same CA) are refused…"); `tests/services/balance-flow.test.mjs` ("an account mapping the bank does not know…", "Carol cannot obtain Alice's balance") | The mock bank shares the development CA |

Baseline controls required by the scenario (not top-15 threats): password + mandatory TOTP
with replay protection and per-session MFA marker (`lib/server/auth-config.js`,
`lib/server/mfa.js`, `lib/server/totp-replay.js`, `lib/server/dal.js` → `assertMfaVerified`),
KYC before money moves (`lib/server/eligibility.js` → `assertVerifiedCustomer`), CSRF and DNS
rebinding defenses (`lib/server/origin.js` → `assertSameOrigin`), security headers
(`next.config.mjs`). Per-threat test results: [docs/PAIR_PROGRAMMING_LOG.md §4](docs/PAIR_PROGRAMMING_LOG.md#4-security-tests).

## How the implementation follows Assignment 5

| Assignment 5 element | Implementation |
|----------------------|----------------|
| Client apps: Customer Next.js app; Internal Ops Portal (read-only, role-based) | One Next.js app: customer routes `/wallet`, `/send`; support routes `/support`, `/operations` behind `requireSupport()` (read-only, audited). The app holds no secrets; the sender is always derived from the session; money-moving requests carry an idempotency key |
| Edge security layer: WAF, rate limiter (per-account, per-route) | Rate limiters for login, MFA and transfer confirmations (`lib/server/rate-limit.js`); same-origin + localhost Host checks; security headers; request size limits. No WAF (deviation) |
| Next.js layer: auth middleware (session, MFA, KYC); route handlers with Zod validation; scoped service tokens from Identity | Server-side DAL on every page and Server Action (`lib/server/dal.js`, `lib/server/session.js`, `lib/server/eligibility.js`); zod and explicit validation; outbound calls with single-use tokens issued by the Identity service; "try again later" on rate/backlog limits |
| Identity, Access & KYC – sole token issuer, owns KYC | `services/identity/` (separate process, only holder of the token signing key); KYC status in the identity DB, enforced before transfers |
| Transaction Processing: Orchestrator & Ledger (sole ledger writer, outbox, holds pending), Fraud & Risk Check (signs decisions, sole key holder), Settlement (verifies signed decision, re-screen on expiry) | Orchestrator: `lib/server/transfer-orchestrator.js` (transfer writer) + `services/orchestrator/` workers; Fraud & Risk: `services/fraud/` (separate process, sole decision key); Settlement: `services/settlement/` (separate process, re-verifies, expired approvals → re-screening) |
| Core Banking Integration – sole path to the bank, sole credential holder, mTLS, strict validation, timeouts, idempotency, read-only records scope for Reconciliation | `services/cbi/` + `lib/cbi/core-banking-client.js`; `corebanking.records:read` lookup used only by Reconciliation |
| Ops Support – read-only, masked fields, access reported to Reconciliation & Audit | `lib/server/support.js`, `lib/server/operations.js`; read-only connections; separate append-only audit writer (`lib/server/audit.js`) |
| Reconciliation & Audit – append-only audit trail, compares records with Core Banking via CBI read-only scope, mismatches alerted not corrected | `services/orchestrator/reconcile.js` + `lib/orchestrator/reconciliation.js` (own certificate `vaultpay-recon`); `audit_event` and `reconciliation_result` append-only |
| Data: separate Transaction DB and Customer & Identity DB, least privilege, append-only ledger; secrets manager; Core Banking System via CBI | Separate SQLite files with logical references only; read-only connections + triggers; per-process secret files generated by setup; mock Core Banking as its own process and database |
| Entity model (Transfer, LedgerEntry, RiskDecision, SettlementRecord, OutboxMessage, AuditEvent, ReconciliationResult; Customer, KycVerification, Wallet, Merchant, OpsUser) | All implemented (`lib/server/db/migrations/`); differences listed below |
| Trust boundaries: every service has its own credentials; no shared network trust | Every link is mutual TLS with exact identities; each process loads only its own secret file; Next.js holds no signing key, bank credential or other service identity (static and setup checks enforce it) |

Per-process credentials, flows and endpoints: [docs/SERVICE_AUTH.md](docs/SERVICE_AUTH.md).

## Deviations from Assignment 5 (documented and justified)

Recorded during implementation (decision numbers refer to
[docs/PAIR_PROGRAMMING_LOG.md §1](docs/PAIR_PROGRAMMING_LOG.md#1-decisions)):

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

Additional deviations found in the final compliance review:

| Assignment 5 says | Implementation | Why |
|---|---|---|
| Customer app includes QR scan and KYC onboarding | No QR-payment or KYC-onboarding screens; KYC status is seeded (Carol pending) and enforced; the ledger and settlement support merchant payees | Scope: the top-15 threats concern the transfer pipeline; onboarding is a vendor integration not in the threat list |
| Circuit breaker on Fraud/Settlement/CBI calls | Hard deadlines + exponential backoff (1 s … 60 s) + parking after 10 attempts | Same fail-closed effect for a single local instance |
| Core Banking Integration runs sandboxed (non-root, minimal egress) | Ordinary local Node.js processes bound to 127.0.0.1 | No container/OS sandbox in a Windows localhost demo; input-side controls implemented |
| Redundant Fraud & Risk instances; replicated Transaction DB | One instance each; SQLite WAL | Single-computer demo |
| Customer notified when a pending transfer expires | Status *Expired* shown on `/wallet` | No messaging channel in the demo |
| Reconciliation compares records periodically | `npm run reconcile` (loop mode every 15 s, or `--once`) | Started by an operator; no scheduler |

## Known limitations

- Localhost demo over plain HTTP: cookies are not `Secure`, no HSTS; the mock bank stands in
  for a partner VaultPay does not control; all keys come from a local development CA.
- Rate limits and the CBI token replay cache are in memory per process (reset on restart);
  all local browsers share one client key, so per-client limits are generous.
- SQLite has no per-connection permissions: narrow writers are enforced by module APIs and
  triggers, not by the database engine.
- Services, workers and reconciliation are started by hand: no supervisor, scheduler,
  alerting or metrics.
- A settlement whose bank outcome stays unknown, "no posting found" or mismatched is kept in
  flight with its funds reserved until the posting appears or a person resolves it with the
  bank; there is no resolution workflow in the UI by design.
- The fraud engine uses fixed demo rules on the transfer alone (no history or velocity).
- No merchant/QR payment UI, KYC onboarding/approval screen, password reset or self-registration.
- Next.js renders pages twice per full load (Cache Components); page side effects are
  idempotent and the operations-view audit is de-duplicated per session for 2 s.
- Multi-step pages need JavaScript in a normal browser.
- `npm ci` may need `--ignore-scripts` on computers without C++ build tools (see above).
- One automated test is skipped on Windows without Developer Mode (file symlinks).

## Third-party dependencies

Runtime (`dependencies`, exact versions pinned in `package.json` and `package-lock.json`):

| Package | Version | Why it was chosen |
|---------|---------|-------------------|
| `next` | 16.4.1 | Required framework: routing, Server Components, Server Actions (the only mutation path), `proxy.js`, production build |
| `react`, `react-dom` | 19.3.0 | Required UI library (forms with `useActionState`, server-rendered pages) |
| `better-sqlite3` | 13.0.3 | Required database: synchronous, transactional SQLite driver with prepared (parameterized) statements; `BEGIN IMMEDIATE` transactions for leases and idempotency; ships prebuilt Windows binaries |
| `better-auth` | 1.7.10 | Established authentication library with SQLite support and a TOTP/backup-code plugin, instead of hand-built password and session handling (D2) |
| `jose` | 6.2.12 | Standards-compliant JWS/JWT signing and verification with EdDSA (Ed25519) for service tokens and signed fraud decisions; strict claim checks (D10) |
| `zod` | 4.6.7 | Strict schema validation of every request and every service/bank response (`.strict()` rejects unknown fields) – threats 220, 274, 289, 85 |
| `qrcode` | 1.5.4 | Renders the TOTP enrollment QR code on the server (no third-party QR service) |

Development only (`devDependencies`, not used at run time):

| Package | Version | Why it was chosen |
|---------|---------|-------------------|
| `eslint` | 9.39.5 (`^9`) | Static analysis / lint |
| `eslint-config-next` | 16.4.1 | Next.js lint rules (React hooks, Next conventions) |
| `selfsigned` | 5.5.0 | Pure-JavaScript certificate generation for the development CA and service certificates during `npm run setup` (no OpenSSL install needed) (D9) |

Transitive packages are pinned by `package-lock.json`. Node.js built-ins used: `node:crypto`,
`node:https`, `node:tls`, `node:test`, `node:worker_threads`. `npm audit --omit=dev` reported
0 vulnerabilities for the runtime dependencies (log, Phases 0 and 3; no runtime dependency was added later); the dev-only ESLint chain has
known advisories with no non-breaking fix (not shipped at run time).

## Tests

```powershell
npm.cmd run lint
npm.cmd test                    # unit + integration tests (temporary installs, never data/)
npm.cmd run build
npm.cmd run smoke               # dependency smoke test
npm.cmd run setup:check         # this computer's installation
npm.cmd run test:http           # the built app over real HTTP with all services (needs build)
npm.cmd run test:services       # Identity / CBI / bank as real processes
npm.cmd run test:mock-bank      # the mock bank as a real process
npm.cmd run test:fraud          # Fraud & Risk and the fraud worker as real processes
npm.cmd run test:settlement     # payment end to end: $500.00 → $487.50 / $250.00 → $262.50
npm.cmd run test:reconcile      # lost bank answers, outages, expiry, parked messages, bank comparison
```

Every command creates its own temporary installation and never touches `data/`. Latest
results: [docs/PAIR_PROGRAMMING_LOG.md §5](docs/PAIR_PROGRAMMING_LOG.md#5-phase-status).

## Further documentation

| Document | Contents |
|----------|----------|
| [docs/SETUP.md](docs/SETUP.md) | Detailed installation, what setup creates, pages and roles, services, fraud/settlement/reconciliation operation, upgrades, troubleshooting |
| [docs/SERVICE_AUTH.md](docs/SERVICE_AUTH.md) | Processes, trust boundaries, credentials per process, every flow (balance, transfer, fraud, settlement, reconciliation), token formats, endpoints |
| [docs/DEMO_CHECKLIST.md](docs/DEMO_CHECKLIST.md) | Demonstration commands and expected results |
| [docs/PRESENTATION_PREP.md](docs/PRESENTATION_PREP.md) | Presentation notes: architecture, workflow, controls, code locations, AI mistakes found and fixed |
| [docs/PAIR_PROGRAMMING_LOG.md](docs/PAIR_PROGRAMMING_LOG.md) | AI pair-programming log: decisions, deviations, problems, security tests, phase status |

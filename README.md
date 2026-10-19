# VaultPay

Secure Software Development – Project 2. A **localhost-only** demonstration of a
peer-to-peer wallet: customers sign in with a password and TOTP, send money to each other,
every transfer is screened by a fraud service that signs its decision, settled once at a
(mock) partner bank through an isolated integration service, recorded in a double-entry
ledger, and reconciled when the bank's answer is lost. Support staff get a read-only,
audited view.

Built with Next.js 16 (Server Actions only), SQLite (better-sqlite3), Better Auth (TOTP),
jose (Ed25519 JWS) and mutual TLS between separate Node.js processes.

> [!WARNING]
> Localhost demonstration only. Setup creates demo accounts with **published, demo-only
> passwords**. Never reuse them for real accounts and never expose this application
> beyond your own computer. Every process listens on `127.0.0.1` only.

## Architecture and trust boundaries

```
Browser ──HTTP (127.0.0.1:3000, session cookie only)──► Next.js "web"
                                                        pages, Server Actions, DAL, transfer writer,
                                                        read-only support & operations views
   │ mTLS vaultpay-web                    │ mTLS vaultpay-web + single-use token
   ▼                                      ▼
Identity (4200)  ── signs service tokens ──► CBI (4300) ── mTLS vaultpay-cbi + credential ──► mock Core Banking (4100)
 only holder of the token signing key       only holder of the bank credential               balances + postings (source of truth)
   ▲ mTLS vaultpay-settlement / vaultpay-recon    ▲ mTLS vaultpay-settlement / vaultpay-recon
Settlement (4500) ◄── mTLS vaultpay-orchestrator ── settlement worker (npm run settlement-worker)
Fraud & Risk (4400) ◄── mTLS vaultpay-orchestrator ── fraud worker (npm run fraud-worker)
 only holder of the decision signing key
                                              reconciliation (npm run reconcile, vaultpay-recon)
```

| Boundary | Rule |
|----------|------|
| Browser → Next.js | Session cookie only (`HttpOnly`, `SameSite=Lax`); every Server Action checks Origin + localhost Host; every page and action re-checks session, MFA, role, KYC and wallet on the server |
| Next.js | Holds no signing key, no bank credential and no other service's certificate; never opens the bank database; names no bank account |
| Identity | Issues three purpose-specific tokens (balance, settlement, reconciliation lookup), each for one caller certificate; callers cannot choose scope, audience, account or amount |
| CBI | The only component that talks to the bank; forwards only what a valid, certificate-bound, single-use token names |
| Fraud & Risk | Stateless; signs approve/decline decisions bound to the exact transfer and screening request |
| Settlement / workers / reconciliation | Separate processes; durable outbox with database leases and fencing; the bank posting is idempotent by key |
| Databases | Identity DB, transaction DB (append-only ledger and audit, state-machine triggers), mock bank DB – each opened only by its owners |

Details: [docs/SERVICE_AUTH.md](docs/SERVICE_AUTH.md) (processes, credentials, every flow
and endpoint) and [docs/SETUP.md](docs/SETUP.md).

## Payment lifecycle

1. **Sign in** – password, then TOTP (or a backup code). Only a session that completed MFA
   reaches protected pages.
2. **Send** (`/send`) – review, then confirm. The server re-checks the sender (active
   customer, approved KYC, own active wallet), the recipient, the amount (integer cents,
   $0.01–$1,000) and a preliminary balance, then writes the transfer (`pending_risk`), its
   audit event and a `fraud_check` outbox message in one transaction. A per-sender
   idempotency key makes resubmission return the same transfer.
3. **Fraud screening** (`npm run fraud-worker`) – signed decision verified against the
   database row → `pending_settlement` or `declined`.
4. **Settlement** (`npm run settlement-worker`) – the approval is re-verified, the attempt is
   recorded before the request leaves, Identity issues a token for exactly one posting, the
   bank debits and credits atomically (funds and account status enforced by the bank) and
   returns the original posting for a repeated key → `completed` with one ledger debit and
   one credit, or `failed` on a definitive first-send refusal. Unknown outcomes stay
   `settlement_in_flight` and are retried with the same key.
5. **Reconciliation and recovery** (`npm run reconcile`) – read-only bank lookup by the
   attempt's key; completes transfers whose posting exists; never fails a transfer because a
   posting is missing; expires overdue transfers that never reached the bank; flags ledger
   and bank mismatches without correcting them.
6. **Operations** (`/operations`) – read-only, audited overview for support users.

## Prerequisites and setup

Windows 10/11, **Node.js 22.23.3** (`.nvmrc`; other versions are refused), npm 10.9.9, Git,
and a TOTP authenticator app. If a terminal shows another Node version, activate Node 22
first.

```powershell
npm.cmd ci
npm.cmd run setup          # creates data/: databases, dev CA + certificates, per-process secrets, demo data
npm.cmd run setup:check    # read-only verification – every line should say PASS
```

`npm run setup` is safe to repeat: it creates only what is missing, backs up and migrates
outdated databases, and upgrades older installations in place (keys, sessions and data are
kept). Everything it generates lives in the git-ignored `data/` folder; each computer runs
its own setup. Current schemas: identity v3, transaction v6, mock bank v2.

## Running

```powershell
npm.cmd run services                  # terminal 1: mock bank, Identity, CBI, Fraud & Risk, Settlement
npm.cmd run dev                       # terminal 2: http://localhost:3000 (or build + start)
npm.cmd run fraud-worker -- --once    # screen submitted transfers  (omit --once to keep running)
npm.cmd run settlement-worker -- --once   # settle approved transfers
npm.cmd run reconcile -- --once       # reconcile ambiguous settlements, expire overdue transfers, check the ledger
```

Without the services the app still works; balances show as temporarily unavailable and
transfers wait. `npm.cmd run reconcile -- --once --requeue-dead` additionally retries parked
messages (an explicit operator decision).

## Demo accounts

| Login | Role | KYC | Opening balance |
|-------|------|-----|-----------------|
| `alice@example.test` | Customer | Approved | $500.00 |
| `bob@example.test` | Customer | Approved | $250.00 |
| `carol@example.test` | Customer | Pending (cannot send) | $100.00 |
| `support@example.test` | Ops, read-only support | – | – |

Passwords: [docs/SETUP.md, section 4](docs/SETUP.md#4-demo-accounts-localhost-only). Every
account enrols TOTP on its first sign-in. Fraud rules decline transfers of **$250.00 or
more** (configurable, `VAULTPAY_FRAUD_DECLINE_AT_CENTS`).

**Step-by-step demonstration with expected results:
[docs/DEMO_CHECKLIST.md](docs/DEMO_CHECKLIST.md).**

## Security controls

| Area | Control |
|------|---------|
| Authentication | Better Auth password login through Server Actions only (no public auth routes, no self-registration); generic errors; rate limits per client and account; mandatory TOTP with replay protection and one-time backup codes; per-session MFA marker set only by the server; 30-minute sessions; logout revokes |
| Authorization | Server-side DAL on every page and action, nothing cached; roles (customer / `support_readonly`); KYC and wallet status checked again immediately before a transfer is written; support is read-only and every lookup or view is audited before data is shown |
| Request integrity | Same-origin check on every Server Action (missing Origin refused), localhost Host allowlist (DNS rebinding), security headers, strict input schemas, integer-cents money |
| Service authentication | mTLS with exact caller and server identities; Ed25519 service tokens: fixed issuer/audience, caller certificate binding, 30 s lifetime, single use, one scope per caller and endpoint |
| Fraud decisions | Signed by Fraud & Risk only; bound to transfer id, parties, amount, currency, screening request; expiring; stored once; re-verified by Identity and Settlement before money moves |
| Money movement | Durable outbox with leases and fencing; attempt recorded before sending; bank-side idempotency with payload check; funds and account status enforced by the bank; unknown outcomes never guessed |
| Data integrity | STRICT SQLite schemas, checksummed migrations, safe open with schema fingerprint; triggers for state transitions, append-only ledger/audit/decisions, double entry tied to the bank posting reference |
| Secrets | Per-process env files generated by setup; each process loads only its own; Next.js refuses another process's secret; nothing generated is committed or traced into the build |

Security tests per threat: [docs/PAIR_PROGRAMMING_LOG.md, section 4](docs/PAIR_PROGRAMMING_LOG.md#4-security-tests).

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
npm.cmd run test:reconcile      # lost bank answers, outages, expiry, parked messages
```

All of them create their own temporary installation; none touches `data/`.

## Deviations from the design (Assignment 5)

The full list with reasons is in
[docs/PAIR_PROGRAMMING_LOG.md, section 2](docs/PAIR_PROGRAMMING_LOG.md#2-deviations-from-assignment-5-for-the-readme).
The main ones: Better Auth instead of Auth.js; SQLite with read-only connections and
triggers instead of database roles; per-process env files instead of a KMS; integer cents;
idempotency keys unique per sender; the transfer writer inside Next.js while the outbox
workers, Fraud & Risk, Settlement, CBI and reconciliation run as separate processes; support
and operations views in the same Next.js app, read-only.

## Known limitations

- Localhost demo over plain HTTP: cookies are not `Secure`, no HSTS; the mock bank stands in
  for a partner the project does not control.
- Rate limits and the CBI token replay cache are in memory per process.
- SQLite has no per-connection permissions: narrow writers are enforced by module APIs and
  triggers, not by the database engine.
- Workers, reconciliation and services are started by hand: no supervisor, scheduler,
  alerting or metrics.
- A settlement whose bank outcome stays unknown (or "no posting found", or a mismatch) is
  kept in flight with its funds reserved until the posting appears or a person resolves it
  with the bank; there is no resolution workflow in the UI by design.
- Reconciliation checks open outcomes only, not completed transfers against bank postings.
- The fraud engine uses fixed demo rules on the transfer alone (no history or velocity).
- No merchant/QR payment UI, KYC approval screen, password reset or self-registration.
- Multi-step pages need JavaScript in a normal browser.
- One automated test is skipped on Windows without Developer Mode (file symlinks).

More detail per step: [docs/PAIR_PROGRAMMING_LOG.md](docs/PAIR_PROGRAMMING_LOG.md).

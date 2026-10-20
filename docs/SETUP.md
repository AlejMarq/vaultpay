# VaultPay – Setup Guide

How to prepare a fresh VaultPay installation on a Windows computer, what `npm run setup`
does, and how to sign in and use the demo. VaultPay is a **localhost demonstration**;
nothing here is meant for a real deployment.

> [!WARNING]
> **Demo-only credentials.** Setup creates demo accounts with the fixed, published
> passwords listed below. Never reuse them for a real account, and never make a
> VaultPay installation reachable from outside your computer (no port forwarding,
> tunnels, or binding to `0.0.0.0`). The app only listens on `127.0.0.1` and only answers
> requests addressed to `localhost` / `127.0.0.1`. Setup refuses to run when
> `NODE_ENV=production`.

---

## 1. Requirements

| Tool | Version | Check with |
|------|---------|------------|
| Windows | 10 or 11 | – |
| Node.js | **22.23.3** (pinned in `.nvmrc`; `package.json` requires 22.x) | `node -v` |
| npm | 10.9.9 | `npm -v` |
| Git | any recent | `git --version` |
| Authenticator app | any TOTP app (Google/Microsoft Authenticator, 1Password, …) | – |

Setup stops with an error on any Node.js version other than 22. If a new terminal shows a
different version (for example a system-wide Node 24), activate Node 22 first.

## 2. Fresh installation

```powershell
git clone https://github.com/AlejMarq/vaultpay.git C:\dev\vaultpay
cd C:\dev\vaultpay
npm.cmd ci                 # exact dependency versions from package-lock.json
npm.cmd run setup          # databases, certificates, secrets, demo data (under data/)
npm.cmd run setup:check    # read-only verification – expect every line to say PASS
npm.cmd test               # unit and integration tests (temporary installs, never data/)
npm.cmd run build
npm.cmd run test:http      # the built app over real HTTP, on a temporary install
npm.cmd run dev            # http://localhost:3000 (listens on 127.0.0.1 only)
```

**If `npm ci` stops at `better-sqlite3` with `gyp ERR! find VS … Could not find any Visual
Studio installation`:** `npm ci` tries to compile it from source although the package ships a
prebuilt Windows binary (`prebuilds/win32-x64.node`). Run `npm.cmd ci --ignore-scripts`
instead – no dependency needs an install script on Windows (verified on a fresh copy of the
submission: lint, all tests and the real-process checks pass). Installing the Visual Studio
C++ Build Tools also works.

`npm.cmd` is used because PowerShell may block `npm.ps1`; `npm` works in other shells.
`npm run start` (after `npm run build`) also listens on `127.0.0.1` only.

### Two computers

Each computer runs its **own** `npm run setup`. Keys, certificates, databases and demo
TOTP enrollments are generated independently and are never copied, committed or synced.
After `git pull`, run `npm ci` (if `package-lock.json` changed) and `npm run setup` again –
it only adds what is missing or migrates an older schema (with a backup).

## 3. What setup creates

Everything is written under `data/`, which is git-ignored:

```
data/
├── db/
│   ├── identity.db             Customer & Identity DB (customers, KYC, wallets, merchants,
│   │                           ops users, TOTP replay claims + Better Auth's user/session/
│   │                           account/verification/twoFactor)
│   ├── transaction.db          Transaction DB (transfers, ledger, risk decisions, settlement
│   │                           attempts, outbox, audit trail + event types, reconciliation)
│   └── mock-core-banking.db    Mock Core Banking (account balances, postings)
├── pki/
│   ├── ca.crt, ca.key          Development CA (2 years) – ca.key is used only by setup
│   └── <service>.crt/.key      cbi, settlement, recon, mock-core-banking, identity, web (1 year)
├── secrets/
│   └── <process>.env           web, identity, fraud, settlement, cbi, mock-core-banking, mock-fraud-scoring
├── backups/                    Copies made before migrations, and items moved by reset options
└── setup-manifest.json         Key IDs, certificate fingerprints/expiry, install IDs – no secrets
```

**Order of steps:** Node/production checks → lock → folder permissions → secrets →
certificates → VaultPay database migrations → Better Auth migrations → demo data →
installation check → manifest.

### Schema versions

| Database | Version | Migrations |
|----------|---------|------------|
| identity | **v3** | `0001` customers, KYC, wallets, merchants, ops users · `0002` TOTP replay claims (`totp_code_use`) · `0003` claim owner token |
| transaction | **v6** | `0001` transfers, ledger, risk, settlement, outbox, audit, reconciliation · `0002` registered audit event types · `0003` transfer audit event type (`transfer.requested`) · `0004` fraud-screening audit event types · `0005` settlement: ledger ↔ bank posting link, double-entry and completion guards, `ledger_totals` view, settlement audit event types · `0006` reconciliation, recovery and operations audit event types |
| mock-core-banking | **v2** | `0001` accounts and postings · `0002` posting reference and currency; postings need two active accounts |

Better Auth's own tables (including the `session.mfaVerifiedAt` column) are created and
upgraded by Better Auth's migrations, which setup runs after VaultPay's.

The app refuses to open a database whose schema is older or newer than the code
(`DB_VERSION_OLD` / `DB_VERSION_NEW`), so after pulling new code run `npm run setup`:
it copies each outdated database to `data/backups/<time>/` and then applies the missing
migrations. Migration files are checksummed – an edited migration stops setup.

**Secrets per process** – each process loads only its own file:

| File | Holds |
|------|-------|
| `web.env` | Better Auth secret, Next.js client certificate (`vaultpay-web`) – **no signing key, no other service identity** |
| `recon.env` | Reconciliation client certificate (`vaultpay-recon`) for `npm run reconcile` (moved out of `web.env` in Step 8) |
| `identity.env` | Service-token **signing** key (only here), Identity server certificate, risk-decision **public** key (Step 7: settlement tokens only for approved transfers) |
| `fraud.env` | Risk-decision **signing** key (only here), Fraud & Risk server certificate (`vaultpay-fraud`), service-token public key, mock fraud-scoring API key |
| `orchestrator.env` | Risk-decision **public** key, fraud-worker client certificate (`vaultpay-orchestrator`) |
| `settlement.env` | Risk-decision **public** key, service-token public key, Settlement client certificate (to Identity and CBI) and server certificate `settlement-server` (CN `vaultpay-settlement`, for the settlement worker) |
| `cbi.env` | Service-token public key, mock Core Banking credential, CBI certificate |
| `mock-core-banking.env` | Mock Core Banking credential and server certificate |
| `mock-fraud-scoring.env` | Mock fraud-scoring API key |

Keys are Ed25519 (used with `jose`). Certificate paths inside the files are relative to
`data/`. The Next.js app reads `web.env` itself (it is never copied into `process.env`).

**Mutual TLS** covers every link between processes: Next.js → Identity and CBI, the fraud
and settlement workers → Fraud & Risk and Settlement, Settlement → Identity and CBI,
reconciliation (`npm run reconcile`) → Identity and CBI with a read-only scope, and CBI →
mock Core Banking (docs/SERVICE_AUTH.md).

## 4. Demo accounts (localhost only)

| Login | Password | Role | KYC | Wallet → bank account | Opening balance |
|-------|----------|------|-----|-----------------------|-----------------|
| `alice@example.test` | `VaultPayDemo-Alice-1!` | Customer | Approved | `wal_demo_alice` → `MCB-1001` | $500.00 |
| `bob@example.test` | `VaultPayDemo-Bob-1!` | Customer | Approved | `wal_demo_bob` → `MCB-1002` | $250.00 |
| `carol@example.test` | `VaultPayDemo-Carol-1!` | Customer | **Pending** | `wal_demo_carol` → `MCB-1003` | $100.00 |
| `support@example.test` | `VaultPayDemo-Support-1!` | Ops – `support_readonly` | – | – | – |

| Merchant | QR identifier | Bank account | Opening balance |
|----------|---------------|--------------|-----------------|
| Demo Coffee (`mer_demo_coffee`) | `vaultpay:merchant:demo-coffee` | `MCB-2001` | $0.00 |

- Carol has funds but a **pending** KYC status, so she shows that unverified customers
  cannot send money. Demo Coffee starts at $0.00 and only receives payments.
- Balances live in the mock Core Banking database, the source of truth (D7). `/wallet`
  shows them through Identity and CBI when the backend services run (section 8).
- Seeded accounts have **no two-factor yet**: each one enrols TOTP on its first sign-in on
  each computer (section 5).
- Passwords are stored only as Better Auth hashes; seeding creates no sessions.
- All addresses use `example.test`, a domain reserved for testing.

Because the passwords are public, whoever signs in to a demo account first on a computer
enrols its TOTP. If you lose the authenticator entry and the backup codes, reset the demo
data with `npm.cmd run setup -- --reset-db` (section 9).

## 5. Signing in, two-factor and sessions

**First sign-in (TOTP enrollment)**

1. Open http://localhost:3000 and sign in with a demo email and password.
2. You land on **Two-factor authentication required** (`/mfa`). Choose *Set up two-factor
   authentication*.
3. Enter your password again.
4. Scan the QR code with your authenticator app, or type the setup key shown below it.
5. Enter the 6-digit code from the app. Two-factor is now on, and VaultPay replaces your
   session with an MFA-verified one.
6. **Save the 10 backup codes** – they are shown only this once. Each works once.
7. Continue to your dashboard: customers go to `/wallet`, support to `/support`.

**Later sign-ins:** email + password, then a code from the app (or one unused backup code)
on `/mfa/verify`. There is no "remember this device" option.

**Sessions:** a session ends after **30 minutes without activity** (navigating or using a
page counts as activity; an idle tab expires). *Sign out* revokes the session immediately.
Wrong passwords and wrong codes are rate-limited (section 7).

**What a password-only session can do:** only see the `/mfa` page (name, email and
instructions) and sign out. Wallet, sending and support pages all require that *this*
session completed a TOTP or backup-code challenge – having TOTP enrolled on the account is
not enough.

## 6. Pages and roles

| Page | Who | What |
|------|-----|------|
| `/login` | anyone | Email + password |
| `/mfa`, `/mfa/setup`, `/mfa/verify` | signed-in / signing-in users | Two-factor status, enrollment, sign-in challenge |
| `/wallet` | active customers (MFA) | Name, email, KYC status, wallet ID and status, **balance** (via Identity and CBI, section 8), recent transfers (read-only) |
| `/send` | active customers (MFA) | Send money to another customer (review → confirm), or why sending is not available right now |
| `/support` | active `support_readonly` users (MFA) | Look up a customer by email: masked email and phone, customer and KYC status, wallet, transfer history. Read-only; every search and view is audited. |
| `/operations` | active `support_readonly` users (MFA) | Read-only operations overview: transfers by status, reserved funds, outbox and parked messages, settlements with an open outcome, reconciliation results and exceptions, ledger integrity, recent operational events. No actions; every view is audited. |
| `/access-denied` | – | Shown for the wrong role, a suspended/closed customer, a disabled ops user, or an account with no VaultPay role |
| `/dashboard` | – | Forwards to `/wallet`, `/support` or `/access-denied` |

Customers cannot open `/support`, support cannot open `/wallet` or `/send`, and a customer
only ever sees their own wallet and transfers. Every page and Server Action checks access
on the server on every request; nothing about access is cached, so a suspension, frozen
wallet or KYC decision applies to the very next request.

### KYC and wallet rules for sending money (`/send`)

Sending requires **all** of: an MFA-verified session, an active customer, an active
wallet owned by that customer, and an **approved latest KYC record**. Otherwise `/send`
explains why:

| Situation | Message |
|-----------|---------|
| KYC pending (Carol) | Verification is still pending; sending is possible once approved |
| KYC rejected | Not approved; contact support |
| No KYC record | Verification not completed yet |
| Wallet frozen / closed / missing | Sending is not available for that wallet |
| Customer suspended / closed | Refused before `/send` (access denied) |

KYC history is append-only: the newest record is the current status. There is no KYC
approval screen yet.

### Sending money (Step 5)

1. On `/send`, enter the recipient's **email** and an amount in USD (`12.50`), then
   **Review transfer**. Nothing is sent and the recipient is not looked up yet.
2. The confirmation shows your wallet, the recipient email and the amount.
   **Confirm and send** submits it; **Change details** goes back.
3. The transfer is accepted as **"Pending – security check"** (`pending_risk`). It is
   **not complete** and no money has moved yet. `/wallet` lists it, and shows the total of
   your outgoing transfers that are not final yet. The fraud worker then screens it
   (*"Pending – awaiting settlement"* or *"Declined"*), and the settlement worker moves the
   money at the bank (*"Completed"* or *"Failed"*) – section 8.

Rules (all checked on the server at confirmation, again just before saving):

| Rule | Detail |
|------|--------|
| Sender | MFA in this session, active customer, approved latest KYC, the active wallet they own (the one their balance comes from) |
| Recipient | Another active customer with an active wallet (KYC is not required to *receive*). Unknown emails, staff accounts, suspended customers and frozen wallets all get the same message: *"That recipient cannot receive transfers."* |
| Amount | $0.01 – $1,000.00 per transfer, at most two decimals, parsed as integer cents |
| Flood limits (threat 121) | At most 30 confirmations per minute per customer (*"Too many transfer attempts"*); at most 20 not-yet-final transfers per wallet and 2,000 in total (*"Too many transfers are still being processed"*). Nothing is written when a limit applies |
| Funds | Your bank balance (fetched through Identity and CBI) minus your transfers still pending must cover it. If the balance cannot be fetched, the transfer is **not** accepted ("We cannot check your balance right now"). This is a preliminary check: the bank enforces funds again at settlement. |
| Duplicates | Each confirmation carries a one-time request key. Submitting it again (double click, retry after an error) returns the same transfer; it is never created twice. |

Try it: Alice → `bob@example.test`, `12.50` → confirm → "Pending – security check".
Carol (KYC pending) sees why she cannot send.

### Support lookups and the audit trail

Support sees only what dispute resolution needs (`a***e@example.test`, `+•-•••-••01`).
Ops accounts and unknown emails give the same "not found". Each search is recorded as
`support.customer_search`, and each customer view as `support.customer_view` (with the
wallet), in the append-only `audit_event` table **before** any data is shown – if the audit
record cannot be written, nothing is shown. Support's database connections are read-only.

## 7. Security protections (summary)

| Protection | Detail |
|------------|--------|
| Localhost only | Listens on `127.0.0.1`; requests addressed to any other host name (DNS rebinding) get no session, no Server Action and a `403` from `/api/health` |
| No public auth routes | Better Auth runs only through Server Actions; `/api/auth/*` does not exist (no self-registration) |
| CSRF | Every Server Action requires an `Origin` matching the localhost `Host` (missing Origin is refused too); cookies are `HttpOnly; SameSite=Lax` |
| Transfer limits | 30 confirmations per minute per customer; pending backlog ≤ 20 per wallet, ≤ 2,000 total (threat 121) |
| Login rate limits | 5 failures per client + email, 10 per email, 30 per client, in 15 minutes; unknown emails are limited the same way |
| MFA rate limits | VaultPay: 5 per client + user, 8 per user, in 15 minutes; Better Auth: 5 attempts per challenge and a 15-minute lock after 10 consecutive failures |
| TOTP replay protection | Each TOTP code is claimed (hashed, per user) before Better Auth checks it, so one code completes at most one verification – also across concurrent attempts. Claims last 2 minutes. |
| MFA marker | `session.mfaVerifiedAt` is set only by Better Auth when it creates a session by completing a second factor; it cannot be set by a client, copied to another session, or extended |
| Headers | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, COOP/CORP `same-origin`; no `X-Powered-By` |
| Reconciliation & recovery | Read-only bank lookup by the attempt's own key (single-use `records:read` token); completes only on a matching posting; never fails a transfer because a posting is missing (a late request could still post); never posts; expiry only for transfers that never sent a settlement request; integrity issues flagged, not corrected |
| Settlement | Completed only after the bank confirms a posting; the bank enforces funds and active accounts itself and returns the original posting for a repeated idempotency key; settlement tokens name one posting, are certificate-bound, 30 s, single use; ledger double entry enforced by triggers |
| Fraud decisions | Signed by Fraud & Risk only (Ed25519, 10-minute expiry), bound to the exact transfer, amount, parties and screening request; verified by the worker before anything changes; stored once (decision id is unique); worker claims are database leases, so concurrent or crashed workers never apply a decision twice |
| Transfers | Server Action re-checks session, MFA, role, KYC and wallet at confirmation and just before saving; sender, source wallet and balance never come from the browser; integer cents; per-sender idempotency key in the database; transfer, audit event and outbox message saved in one database transaction; never marked completed on acceptance |
| Service boundaries | Mock bank, Identity and CBI are separate processes on `127.0.0.1` with mutual TLS and exact caller allowlists; only Identity holds the token signing key, only CBI the bank credential; balance tokens are single-use, 30-second, certificate-bound (`docs/SERVICE_AUTH.md`) |
| Build hygiene | `next build` never opens `data/`, and no database, key or secret is traced into build output (checked by `npm run test:http`) |

Limits: plain HTTP on localhost (cookies are not `Secure`); multi-step pages need
JavaScript; integrity checks and permissions stop mistakes and other local accounts, not
an administrator or malware running as you.

## 8. Backend services and balances (Step 4)

Customer balances come from three backend services, each its own Node.js process on
`127.0.0.1`, talking to each other only over mutual TLS:

| Service | Start alone | Port (variable) | Role |
|---------|-------------|-----------------|------|
| mock Core Banking | `npm.cmd run mock-bank` | 4100 (`VAULTPAY_MOCK_BANK_PORT`) | Stands in for the bank; holds the balances; accepts only CBI |
| Identity | `npm.cmd run identity` | 4200 (`VAULTPAY_IDENTITY_PORT`) | The **only** holder of the service-token signing key; issues a 30-second, single-use balance token for a signed-in, MFA-verified customer |
| CBI | `npm.cmd run cbi` | 4300 (`VAULTPAY_CBI_PORT`) | The only component that talks to Core Banking; returns the balance for the account named in a valid token |
| Fraud & Risk | `npm.cmd run fraud` | 4400 (`VAULTPAY_FRAUD_PORT`) | The **only** holder of the risk-decision signing key; screens a transfer and returns a signed approve/decline decision; accepts only the fraud worker |
| Settlement | `npm.cmd run settlement` | 4500 (`VAULTPAY_SETTLEMENT_PORT`) | Moves money for one approved transfer: verifies the approval, gets a single-use settlement token from Identity, presents it to CBI; accepts only the settlement worker; holds no bank credential |

**To see balances on `/wallet`:**

```powershell
npm.cmd run services     # terminal 1: mock bank, Identity, CBI, Fraud & Risk, Settlement (Ctrl+C stops all)
npm.cmd run dev          # terminal 2: the app
```

Without the services the app still works; `/wallet` says *"Your balance is temporarily
unavailable"*. A frozen or closed wallet shows no balance. Each customer only ever sees their
own balance – the bank account is decided by Identity from its own records, never by the
browser or by Next.js.

**Checks:**

```powershell
npm.cmd run test:mock-bank   # the bank as a real process
npm.cmd run test:services    # all three as real processes: binding, mTLS allowlists, no secrets
npm.cmd run test:http        # the built app end to end, with all services and the fraud worker
npm.cmd run test:fraud       # Fraud & Risk and the fraud worker as real processes
npm.cmd run test:settlement  # all five services and both workers as real processes
npm.cmd run test:reconcile   # reconciliation and recovery against real processes
```

All three refuse to start without `npm run setup` (`CONFIG_MISSING`) and on Node.js other
than 22. Which process holds which certificate, key and database connection, the token
format and the request/response formats are in **[docs/SERVICE_AUTH.md](SERVICE_AUTH.md)**.

**Upgrading an older installation:** before Step 4B, `web.env` held the service-token
signing key. `npm.cmd run setup` now moves that key **unchanged** into the new
`identity.env` (old `web.env` backed up), and issues the new `identity` and `web`
certificates from the existing CA. Sessions, TOTP enrollments and all data are kept. Until
then the app fails closed – no page is served and `/api/health` reports `unavailable`
(server log: `web.env must not contain SERVICE_TOKEN_SIGNING_KEY`).
### Fraud screening (Step 6)

Submitted transfers wait as *"Pending – security check"* until the **fraud worker**
screens them. The worker takes each transfer's `fraud_check` outbox message, sends the
transfer as recorded in the database to Fraud & Risk, verifies the signed decision and
applies it:

| Decision | Transfer becomes | `/wallet` shows |
|----------|------------------|-----------------|
| approve | `pending_settlement` (queued for the settlement worker, below) | Pending – awaiting settlement |
| decline | `declined` (final; no longer held against the balance) | Declined |

```powershell
npm.cmd run services                    # terminal 1 (includes Fraud & Risk)
npm.cmd run dev                         # terminal 2
npm.cmd run fraud-worker                # terminal 3: screens new transfers every 2 s (Ctrl+C stops)
npm.cmd run fraud-worker -- --once      # or: screen everything due now, then exit
```

**Demo:** sign in as Alice, send **$12.50** to `bob@example.test` and **$300.00** to
`bob@example.test`; run `npm.cmd run fraud-worker -- --once` → it prints
`pending_settlement=1 declined=1`; `/wallet` shows *Pending – awaiting settlement* and
*Declined*.

Demo rules (deterministic, `lib/fraud/engine.js`): **decline** when the amount is
**$250.00 or more**, the payee is the sender's own wallet, the payee is on the block list,
or the transfer's time is implausible; otherwise **approve**. Change the threshold or block
list when starting Fraud & Risk, e.g. in PowerShell
`$env:VAULTPAY_FRAUD_DECLINE_AT_CENTS='1000'; npm.cmd run fraud` (declines from $10.00) or
`$env:VAULTPAY_FRAUD_BLOCKED_PAYEES='wal_demo_bob'`.

If Fraud & Risk is not running, nothing is approved: the transfer stays *Pending – security
check* and the worker retries with a growing pause (1 s … 60 s; after 10 failed attempts the
message is parked as `dead` and the transfer stays pending). Several workers can run at
once; each transfer is screened and applied once.

**Upgrading:** `npm.cmd run setup` gives `fraud.env` its certificate, creates
`orchestrator.env` (the decision **public** key, derived from the existing signing key)
and issues the `fraud` and `orchestrator` certificates from the existing CA; the
transaction database is migrated to v4 (backup first).

### Settlement (Step 7)

The **settlement worker** takes each approved transfer's `settlement` outbox message and
moves the money at the (mock) bank. Only a confirmed bank posting makes a transfer
*Completed*:

| Bank answer | Transfer becomes | `/wallet` shows |
|-------------|------------------|-----------------|
| posted (also when a retry finds the original posting) | `completed` – ledger debit + credit written | Completed, and the new balance |
| refusal of the **first** send (insufficient funds, account frozen/closed at the bank, a VaultPay party no longer active) | `failed` – nothing moved | Failed |
| refusal after an earlier unanswered send | stays `settlement_in_flight` (the earlier request could still post); retried with the same key | Processing |
| no answer / timeout / outage | stays `settlement_in_flight`; retried with the **same** bank idempotency key | Processing |
| approval expired before sending | back to `pending_risk` and screened again | Pending – security check |

```powershell
npm.cmd run services                          # terminal 1 (includes Settlement)
npm.cmd run dev                               # terminal 2
npm.cmd run fraud-worker -- --once            # screen submitted transfers
npm.cmd run settlement-worker -- --once       # settle approved ones (or run both without --once)
```

**Demo (fresh install):** Alice sends **$12.50** to `bob@example.test` → `fraud-worker
--once` (`pending_settlement=1`) → `settlement-worker --once` (`completed=1`) → Alice's
`/wallet` shows *Completed* and **$487.50**; Bob's shows **$262.50**. A **$300.00**
transfer is declined by fraud and never reaches the bank.

To see a bank timeout: stop the services, start the bank alone with
`$env:VAULTPAY_MOCK_BANK_POST_DELAY_MS='4500'; npm.cmd run mock-bank` (it answers after CBI
gave up), start the others, settle – the transfer shows *Processing*; restart the bank
normally and settle again – it completes with the original posting, money moved once.

**Upgrading:** `npm.cmd run setup` adds the Settlement server certificate and paths to
`settlement.env`, adds the risk-decision **public** key to `identity.env` (from
`settlement.env`; nothing is regenerated, old files backed up), and migrates the
transaction database to v5 and the mock bank database to v2 (backups first; balances and
existing data are kept).

### Operations: reconciliation and recovery (Step 8)

**Monitoring.** Sign in as `support@example.test` → `/support` → *Operations overview*
(`/operations`). It is read-only: no buttons, no actions. Watch:

| Section | What needs attention |
|---------|----------------------|
| Settlements with an open outcome | `settlement_in_flight` with bank outcome `unknown`/`pending` – their funds stay reserved until resolved |
| Parked messages | `dead` fraud/settlement messages (`last_error` says why, e.g. `fraud_unavailable`, `needs_reconciliation`) |
| Exceptions | the bank holds a posting for the attempt's key whose details differ – investigate; never corrected automatically |
| Ledger integrity | must say *balanced* with no issues |
| Overdue pending | transfers past their 1-hour deadline, waiting for the next reconcile pass |

**Recovery runs on the server** (an operator with access to this computer, not the web UI):

```powershell
npm.cmd run reconcile -- --once                  # one pass
npm.cmd run reconcile                            # or keep it running (every 15 s)
npm.cmd run reconcile -- --once --requeue-dead   # also retry parked messages (operator decision)
```

A pass:

1. **Expires** `pending_risk`/`pending_settlement` transfers past their deadline that never
   sent a settlement request (and no worker holds right now) → *Expired*; funds released.
2. **Reconciles** each settlement with an open outcome older than 2 minutes and not being
   worked on: asks the bank – read-only – whether it holds a posting for the attempt's own
   idempotency key with the expected transfer, accounts, amount and currency:
   - **posted** → *Completed*, one ledger debit + credit, result `matched`;
   - **not posted (yet)** → left unresolved, funds stay reserved. A missing posting is not proof
     that none will appear (a request may still be inside the bank), so it never fails the
     transfer; if the posting appears later the next pass completes it;
   - **different details** → exception, left in flight (funds reserved);
   - **cannot tell** (bank/CBI/Identity down, invalid answer) → nothing changes; retried next pass.
   It never sends a payment.
3. **Requeues** (only with `--requeue-dead`) a parked fraud check of a transfer still awaiting
   screening, or a parked settlement message of a transfer not yet sent – as a new message.
   Settlements already in flight are never requeued; reconciliation resolves them.
4. **Compares finished transfers with the bank** (threat 284): every completed or failed
   transfer is checked once against the bank's own record for its attempt's key – completed
   must match the bank's posting exactly, failed must have no posting. Agreement → result
   `matched`; anything else → `mismatched`, audit `reconciliation.mismatch`, listed as an
   exception on `/operations` – never corrected. If the bank cannot be asked, it is retried
   next pass.
5. **Checks the ledger** (debits = credits; one debit + credit per completed transfer) and
   records any issue as `ledger.integrity_mismatch` – never corrects it.

Every outcome is recorded (`reconciliation_result`, audit events `transfer.reconciled`,
`reconciliation.mismatch`, `reconciliation.unresolved`, `transfer.expired`, `outbox.requeued`,
`ledger.integrity_mismatch`) and shown on `/operations`.

**Manual resolution.** A transfer that stays *Processing* with "no posting found" (or a
mismatch) needs a person: confirm with the bank that the key can no longer post, then resolve
it outside the web UI. Until then its funds stay reserved – VaultPay never guesses.

**Demo – a lost bank answer:** start the bank with `$env:VAULTPAY_MOCK_BANK_POST_DELAY_MS='4500'`,
send $12.50 Alice → Bob, run `fraud-worker --once` and `settlement-worker --once` → the
transfer shows *Processing* (the bank did post); restart the bank normally, wait two
minutes (or set `$env:VAULTPAY_RECONCILE_MIN_AGE_MS='1000'`), run `npm.cmd run reconcile -- --once`
→ `completed=1`; Alice's wallet shows *Completed* and $487.50; `/operations` lists the
`matched` result.

**Upgrading:** `npm.cmd run setup` moves the Reconciliation certificate paths from `web.env`
to a new `recon.env` (same certificate; old `web.env` backed up) and migrates the transaction
database to v6 (backup first).

## 9. Running setup again, and replacing items

Re-running is safe and is the normal way to update an installation:

- Anything **missing** is created; anything **present** is verified and left untouched.
- An outdated database schema is **backed up, then migrated** (section 3).
- Demo data is created **only if missing** – a repeat run never duplicates accounts and
  never resets balances, KYC decisions or TOTP enrollments.
- Secrets and certificates are complete sets. If some files of a set are missing or
  invalid, setup **stops without changing anything** and tells you which option replaces
  the set.
- Existing data that conflicts with the demo definitions stops setup instead of being changed.

| Command | Effect | Confirm by typing |
|---------|--------|-------------------|
| `npm.cmd run setup -- --reset-db` | Moves all three databases to `data/backups/<time>/` and creates new ones with fresh demo data. **All accounts, TOTP enrollments, sessions, transfers, audit records and balances are reset.** | `RESET` |
| `npm.cmd run setup -- --rotate-secrets` | Moves `data/secrets/` to backups and generates new keys. Sessions stop working, and **TOTP enrollments made with the old Better Auth secret can no longer be verified** – combine with `--reset-db`. | `ROTATE` |
| `npm.cmd run setup -- --renew-certs` | Moves `data/pki/` to backups and issues a new CA and service certificates. | `RENEW` |

Options can be combined. Without an interactive terminal the confirmation fails and
nothing is changed. Old items are moved, never deleted. Stop any running VaultPay
processes first.

## 10. `npm run setup:check`

Read-only; exit code 1 if any line is `FAIL`. It checks:

| Area | Checks |
|------|--------|
| directories | `data/` folders exist and are not links or junctions |
| permissions | `data/` is restricted to the current Windows user (`WARN` only – best effort) |
| secrets | exact file set; each process has exactly its own keys; key pairs and key IDs match; shared API keys agree; strong values; certificate paths stay in `data/pki` |
| certificates | chain to the CA, key matches certificate, subject, usage (server/client), localhost SAN, validity; `WARN` within 30 days of expiry |
| databases | each opens read-only and passes path, integrity, identity, **schema-version** and full schema checks plus `integrity_check` and `foreign_key_check` |
| better auth | all 5 Better Auth tables exist with the columns (including `session.mfaVerifiedAt`) and indexes the configuration expects |
| accounts | every wallet and merchant has a mock Core Banking account |
| demo data | every demo login, customer, KYC record, wallet, ops user and merchant is present and linked |
| git | generated files are git-ignored and none are tracked |

## 11. Troubleshooting

| Message | Meaning / fix |
|---------|---------------|
| `VaultPay requires Node.js 22` | Activate Node 22.23.3 (`.nvmrc`); check `node -v` in the same terminal. |
| `DB_VERSION_OLD: … database is at schema vN, code needs vM; run npm run setup` | New code with new migrations – run `npm.cmd run setup` (it backs up first). |
| `Better Auth table session is missing columns: mfaVerifiedAt` | Run `npm.cmd run setup`; it adds the column. |
| `/api/health` answers `{"status":"unavailable"}` | The server log names the problem (`config:…`, `identity:DB_…`); usually setup has not been run on this computer. |
| `Incorrect email or password.` | Wrong email or password (the message never says which). |
| `Too many sign-in attempts …` / `Too many attempts …` | Rate limit; wait the minutes shown. Limits are in memory – restarting the server clears VaultPay's (not Better Auth's 15-minute account lock). |
| `That code is not valid …` for a code that looks right | Check the computer's clock; a code can also be used only **once** – wait for the next code. |
| `Your sign-in has expired` / `Too many incorrect codes. Please sign in again.` | The 10-minute challenge expired or used up its 5 attempts – sign in again. |
| Lost authenticator **and** backup codes | Reset the demo data: `npm.cmd run setup -- --reset-db`. |
| `/access-denied` | The account has the wrong role for that page, or is suspended/closed/disabled. |
| `another setup appears to be running` | A previous run was interrupted. If no setup is running, delete `data/.setup.lock`. |
| `secrets exist but are incomplete or invalid …` / `certificates exist but …` | Files were removed or edited. Restore them, or replace the set with the option named in the message. |
| `not a readable SQLite database` / `schema differs from its migrations` | A database file was replaced or edited by hand. Restore it from `data/backups/`, or use `--reset-db`. |
| `could not move … (EBUSY)` | Stop `npm run dev` / `npm start` and other VaultPay processes, then retry. |
| `WARN permissions …` | `icacls` could not restrict `data/`; check the folder's Security tab. Setup still completes. |
| `refusing to run: NODE_ENV=production` | Unset `NODE_ENV` – VaultPay is a localhost demo. |
| `mock Core Banking` / `Identity service` / `CBI cannot start: CONFIG_MISSING` | Run `npm.cmd run setup` first (it also upgrades older installations). |
| `web.env must not contain SERVICE_TOKEN_SIGNING_KEY` | An installation from before Step 4B – run `npm.cmd run setup` (moves the key to `identity.env`, keeps everything else). |
| `Your balance is temporarily unavailable` | Start the services: `npm.cmd run services`. The server log line `[balance] unavailable: …` says which step failed. |
| `EADDRINUSE` on port 4100 (mock bank) | Another mock bank is running; stop it or set `VAULTPAY_MOCK_BANK_PORT`. |
| `EADDRINUSE` on port 3000 | Another server is running; stop it or use `npm.cmd run dev -- --port 3001` (then open that port on `localhost`). |

Empty `*.db-wal` / `*.db-shm` files next to the databases are normal SQLite working files.

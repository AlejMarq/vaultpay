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
│   └── <service>.crt/.key      cbi, settlement, recon, mock-core-banking (1 year)
├── secrets/
│   └── <process>.env           web, fraud, settlement, cbi, mock-core-banking, mock-fraud-scoring
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
| transaction | **v2** | `0001` transfers, ledger, risk, settlement, outbox, audit, reconciliation · `0002` registered audit event types |
| mock-core-banking | v1 | `0001` accounts and postings |

Better Auth's own tables (including the `session.mfaVerifiedAt` column) are created and
upgraded by Better Auth's migrations, which setup runs after VaultPay's.

The app refuses to open a database whose schema is older or newer than the code
(`DB_VERSION_OLD` / `DB_VERSION_NEW`), so after pulling new code run `npm run setup`:
it copies each outdated database to `data/backups/<time>/` and then applies the missing
migrations. Migration files are checksummed – an edited migration stops setup.

**Secrets per process** – each process loads only its own file:

| File | Holds |
|------|-------|
| `web.env` | Better Auth secret, service-token **signing** key (Identity), Reconciliation client certificate |
| `fraud.env` | Risk-decision **signing** key, service-token public key, mock fraud-scoring API key |
| `settlement.env` | Risk-decision **public** key, service-token public key, Settlement client certificate |
| `cbi.env` | Service-token public key, mock Core Banking credential, CBI certificate |
| `mock-core-banking.env` | Mock Core Banking credential and server certificate |
| `mock-fraud-scoring.env` | Mock fraud-scoring API key |

Keys are Ed25519 (used with `jose`). Certificate paths inside the files are relative to
`data/`. The Next.js app reads `web.env` itself (it is never copied into `process.env`).

**Mutual TLS** currently covers the Core Banking links: Settlement → CBI,
Reconciliation (inside Next.js) → CBI with a read-only scope, and CBI → mock Core Banking.

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
- Balances live in the mock Core Banking database, the source of truth (D7). The app does
  not read them yet – that needs Core Banking Integration (Step 4).
- Seeded accounts have **no two-factor yet**: each one enrols TOTP on its first sign-in on
  each computer (section 5).
- Passwords are stored only as Better Auth hashes; seeding creates no sessions.
- All addresses use `example.test`, a domain reserved for testing.

Because the passwords are public, whoever signs in to a demo account first on a computer
enrols its TOTP. If you lose the authenticator entry and the backup codes, reset the demo
data with `npm.cmd run setup -- --reset-db` (section 8).

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
| `/wallet` | active customers (MFA) | Name, email, KYC status, wallet ID and status, recent transfers (read-only). The balance shows *"Balance retrieval will be available after Core Banking Integration (CBI) is connected."* |
| `/send` | active customers (MFA) | Whether you may send money right now, and why not. No transfer form yet (Step 5). |
| `/support` | active `support_readonly` users (MFA) | Look up a customer by email: masked email and phone, customer and KYC status, wallet, transfer history. Read-only; every search and view is audited. |
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
| Login rate limits | 5 failures per client + email, 10 per email, 30 per client, in 15 minutes; unknown emails are limited the same way |
| MFA rate limits | VaultPay: 5 per client + user, 8 per user, in 15 minutes; Better Auth: 5 attempts per challenge and a 15-minute lock after 10 consecutive failures |
| TOTP replay protection | Each TOTP code is claimed (hashed, per user) before Better Auth checks it, so one code completes at most one verification – also across concurrent attempts. Claims last 2 minutes. |
| MFA marker | `session.mfaVerifiedAt` is set only by Better Auth when it creates a session by completing a second factor; it cannot be set by a client, copied to another session, or extended |
| Headers | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, COOP/CORP `same-origin`; no `X-Powered-By` |
| Build hygiene | `next build` never opens `data/`, and no database, key or secret is traced into build output (checked by `npm run test:http`) |

Limits: plain HTTP on localhost (cookies are not `Secure`); multi-step pages need
JavaScript; integrity checks and permissions stop mistakes and other local accounts, not
an administrator or malware running as you.

## 8. Running setup again, and replacing items

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

## 9. `npm run setup:check`

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

## 10. Troubleshooting

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
| `EADDRINUSE` on port 3000 | Another server is running; stop it or use `npm.cmd run dev -- --port 3001` (then open that port on `localhost`). |

Empty `*.db-wal` / `*.db-shm` files next to the databases are normal SQLite working files.

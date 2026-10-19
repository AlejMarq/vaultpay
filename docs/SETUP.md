# VaultPay – Setup Guide

How to prepare a fresh VaultPay installation on a Windows computer, and what
`npm run setup` does. VaultPay is a **localhost demonstration**; nothing here is meant
for a real deployment.

> [!WARNING]
> **Demo-only credentials.** Setup creates demo accounts with the fixed, published
> passwords listed below. Never reuse them for a real account, and never make a
> VaultPay installation reachable from outside your computer (no port forwarding,
> tunnels, or `next dev -H 0.0.0.0` on a shared network). Setup refuses to run when
> `NODE_ENV=production`.

---

## 1. Requirements

| Tool | Version | Check with |
|------|---------|------------|
| Windows | 10 or 11 | – |
| Node.js | **22.23.3** (pinned in `.nvmrc`; `package.json` requires 22.x) | `node -v` |
| npm | 10.9.9 | `npm -v` |
| Git | any recent | `git --version` |

Setup stops with an error on any Node.js version other than 22.

## 2. Fresh installation

```powershell
git clone https://github.com/AlejMarq/vaultpay.git C:\dev\vaultpay
cd C:\dev\vaultpay
npm.cmd ci                 # exact dependency versions from package-lock.json
npm.cmd run setup          # databases, certificates, secrets, demo data (under data/)
npm.cmd run setup:check    # read-only verification – expect every line to say PASS
npm.cmd test               # automated tests
npm.cmd run dev            # http://localhost:3000
```

`npm.cmd` is used because PowerShell may block `npm.ps1`; `npm` works in other shells.

### Two computers

Each computer runs its **own** `npm run setup`. Keys, certificates and databases are
generated independently and are never copied, committed or synced. After `git pull`,
run `npm ci` (if `package-lock.json` changed) and `npm run setup` again – it only adds
what is missing or migrates an older schema.

## 3. What setup creates

Everything is written under `data/`, which is git-ignored:

```
data/
├── db/
│   ├── identity.db             Customer & Identity DB (customers, KYC, wallets, merchants,
│   │                           ops users + Better Auth's user/session/account/verification/twoFactor)
│   ├── transaction.db          Transaction DB (transfers, ledger, risk decisions, settlement
│   │                           attempts, outbox, audit, reconciliation) – empty at first
│   └── mock-core-banking.db    Mock Core Banking (account balances, postings)
├── pki/
│   ├── ca.crt, ca.key          Development CA (2 years) – ca.key is used only by setup
│   └── <service>.crt/.key      cbi, settlement, recon, mock-core-banking (1 year)
├── secrets/
│   └── <process>.env           web, fraud, settlement, cbi, mock-core-banking, mock-fraud-scoring
├── backups/                    Old items moved here by the reset options below
└── setup-manifest.json         Key IDs, certificate fingerprints/expiry, install IDs – no secrets
```

**Order of steps:** Node/production checks → lock → folder permissions → secrets →
certificates → VaultPay database migrations → Better Auth migrations → demo data →
installation check → manifest.

**Secrets per process** – each process loads only its own file:

| File | Holds |
|------|-------|
| `web.env` | Better Auth secret, service-token **signing** key (Identity), Reconciliation client certificate |
| `fraud.env` | Risk-decision **signing** key, service-token public key, mock fraud-scoring API key |
| `settlement.env` | Risk-decision **public** key, service-token public key, Settlement client certificate |
| `cbi.env` | Service-token public key, mock Core Banking credential, CBI certificate |
| `mock-core-banking.env` | Mock Core Banking credential and server certificate |
| `mock-fraud-scoring.env` | Mock fraud-scoring API key |

Keys are Ed25519 (used with `jose`). Certificate paths inside the files are relative to `data/`.

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

- Carol has funds but a **pending** KYC status, so she can show that unverified customers
  cannot move money. Demo Coffee starts at $0.00 and only receives payments.
- Balances live in the mock Core Banking database, which is the source of truth (D7).
- No demo account has two-factor authentication yet. Each user **enrols TOTP on first
  sign-in** (sign-in UI arrives in Step 3).
- Users are created through Better Auth's sign-up API, so passwords are stored only as
  Better Auth hashes. Seeding creates no sessions.
- All addresses use `example.test`, a domain reserved for testing.

## 5. Running setup again

Re-running is safe and is the normal way to update an installation:

- Anything **missing** is created; anything **present** is verified and left untouched.
- Demo data is created **only if missing** – a repeat run never duplicates accounts and
  never resets balances or KYC decisions made after seeding.
- Secrets and certificates are complete sets. If some files of a set are missing or
  invalid, setup **stops without changing anything** and tells you which option replaces
  the set (regenerating part of a set would break key pairs or the certificate chain).
- An existing database is never replaced. If its schema is older than the code, setup
  backs it up to `data/backups/<time>/` and then migrates it.
- Existing data that conflicts with the demo definitions (for example another merchant
  holding Demo Coffee's QR code) stops setup instead of being changed.

## 6. Replacing items (explicit, confirmed)

| Command | Effect | Confirm by typing |
|---------|--------|-------------------|
| `npm.cmd run setup -- --reset-db` | Moves all three databases to `data/backups/<time>/`, creates new ones with fresh demo data. **All accounts, sessions, transfers and balances are reset.** | `RESET` |
| `npm.cmd run setup -- --rotate-secrets` | Moves `data/secrets/` to backups and generates new keys. Sessions stop working, and **TOTP enrollments made with the old Better Auth secret can no longer be verified** – combine with `--reset-db` if users enrolled. | `ROTATE` |
| `npm.cmd run setup -- --renew-certs` | Moves `data/pki/` to backups and issues a new CA and service certificates. | `RENEW` |

Options can be combined. Without an interactive terminal the confirmation fails and
nothing is changed. Old items are moved, never deleted. Stop any running VaultPay
processes first.

## 7. `npm run setup:check`

Read-only; exit code 1 if any line is `FAIL`. It checks:

| Area | Checks |
|------|--------|
| directories | `data/` folders exist and are not links or junctions |
| permissions | `data/` is restricted to the current Windows user (`WARN` only – best effort) |
| secrets | exact file set; each process has exactly its own keys; key pairs and key IDs match; shared API keys agree; strong values; certificate paths stay in `data/pki` |
| certificates | chain to the CA, key matches certificate, subject, usage (server/client), localhost SAN, validity; `WARN` within 30 days of expiry |
| databases | each opens read-only and passes path, integrity, identity, schema-version and full schema checks plus `integrity_check` and `foreign_key_check` |
| better auth | all 5 Better Auth tables exist with the columns and indexes the configuration expects |
| accounts | every wallet and merchant has a mock Core Banking account |
| demo data | every demo login, customer, KYC record, wallet, ops user and merchant is present and linked |
| git | generated files are git-ignored and none are tracked |

## 8. Security notes and limits

- **Permissions:** on Windows, setup removes inherited permissions from `data/` and grants
  access to the current user only (`icacls`); files inside inherit that. Failures are shown
  as `WARN` lines – they are never silently ignored. This keeps other local accounts out; it
  does not protect against an administrator or malware running as you.
- **Integrity checks** (schema comparison, append-only triggers, read-only connections)
  catch mistakes and accidental mix-ups. They are not a barrier against someone who can
  already write to `data/` (see the pair-programming log, D3/D4).
- `data/`, `*.env`, `*.key`, `*.crt`, `*.pem` and the manifest are git-ignored everywhere in
  the repository.

## 9. Troubleshooting

| Message | Meaning / fix |
|---------|---------------|
| `VaultPay requires Node.js 22` | Activate Node 22.23.3 (`.nvmrc`). |
| `another setup appears to be running` | A previous run was interrupted. If no setup is running, delete `data/.setup.lock`. |
| `secrets exist but are incomplete or invalid …` / `certificates exist but …` | Files were removed or edited. Restore them, or replace the set with the option named in the message. |
| `not a readable SQLite database` / `schema differs from its migrations` | A database file was replaced or edited by hand. Restore it from `data/backups/`, or use `--reset-db`. |
| `could not move … (EBUSY)` | Stop `npm run dev` / `npm start` and other VaultPay processes, then retry. |
| `WARN permissions …` | `icacls` could not restrict `data/`; check the folder's Security tab. Setup still completes. |
| `refusing to run: NODE_ENV=production` | Unset `NODE_ENV` – VaultPay is a localhost demo. |

Empty `*.db-wal` / `*.db-shm` files next to the databases are normal SQLite working files.

# VaultPay – Service Trust Boundaries and Service Authentication

Status: Step 4B implemented – Identity and CBI service processes, Identity-issued service
tokens, customer balances on `/wallet`. Settlement and Reconciliation tokens follow in later
steps with the same rules.

## 1. Processes and trust boundaries

```
 Browser ──plain HTTP, localhost only──► Next.js "web" (127.0.0.1:3000)
   session cookie only                     pages, Server Actions, DAL, Orchestrator,
                                           Ops Support, Reconciliation & Audit
                │                               │
                │                 (1) mTLS CN=vaultpay-web
                │                     + the customer's own session token
                │                               ▼
                │                         Identity service (127.0.0.1:4200)
                │                         ONLY holder of the service-token signing key;
                │                         read-only identity DB (sessions, wallets)
                │                               │ returns a 30-s, single-use, cert-bound token
                │                               ▼
                │                 (2) mTLS CN=vaultpay-web + service token
                │                               ▼
                │                         CBI – Core Banking Integration (127.0.0.1:4300)
                │                         ONLY holder of the Core Banking credential
                │                               │ (3) mTLS CN=vaultpay-cbi + credential
                │                               ▼
                │                         mock Core Banking (127.0.0.1:4100)
                │                         owns mock-core-banking.db
                ▼
   gets only "balance $X as of …" or "temporarily unavailable"

 Fraud worker (npm run fraud-worker) ──(4) mTLS CN=vaultpay-orchestrator──► Fraud & Risk (127.0.0.1:4400)
   Orchestrator process; transaction DB              ONLY holder of the risk-decision
   read-write; risk-decision PUBLIC key              signing key; no database; returns a
   ◄── signed decision (JWS) ─────────────────────── signed approve/decline

 Settlement worker (npm run settlement-worker) ──(5) mTLS CN=vaultpay-orchestrator──► Settlement (127.0.0.1:4500)
   transaction DB read-write                         verifies the approval; no bank credential
                                                          │ (6) mTLS CN=vaultpay-settlement + approval
                                                          ▼
                                                     Identity → settlement token for ONE posting
                                                          │ (7) mTLS CN=vaultpay-settlement + token, no body
                                                          ▼
                                                     CBI → (3) → mock Core Banking: one atomic,
                                                     idempotent posting (funds + active accounts)

 Reconciliation (npm run reconcile) ──(8) mTLS CN=vaultpay-recon──► Identity → read-only lookup token
   transaction DB read-write                 ──(9) mTLS CN=vaultpay-recon + token, no body──► CBI
                                                     → mock Core Banking GET posting by key (read-only)
```

- **The browser** receives no certificate, key, service token, session token, bank
  account reference or internal error – only its `HttpOnly` session cookie and pages.
- **Next.js holds no signing key and no Core Banking credential.** If `web.env` contains the
  signing key or another process's secret it fails closed: it serves no page and
  `/api/health` reports `unavailable`. It never names a bank
  account: it asks Identity for a token by presenting the customer's own session.
- **Identity** is the only issuer. It decides the account from its own records.
- **CBI** reads only the account named inside a valid Identity token; requests carry no
  account. It is the only component that talks to Core Banking (D1, threats 280/85/220/282).
- **The mock bank** trusts only CBI.

Every service listens on `127.0.0.1` only. Every service-to-service connection is mutual
TLS against the installation's development CA with `rejectUnauthorized: true`, an exact
allowlist of caller certificate CNs on the server, and an exact expected server CN on the
client.

## 2. Who owns which credential and connection

| Process | Loads only | Holds | Database connections |
|---------|-----------|-------|----------------------|
| Next.js (`web`) | `data/secrets/web.env` | Better Auth secret; client certificate `vaultpay-web` + key; CA. **No signing key, no Core Banking credential, no other service's certificate** (the Reconciliation certificate moved to `recon.env` in Step 8) | identity DB (Better Auth: read-write; DAL and support: read-only); transaction DB (read-only; separate append-only audit writer). **Never** the mock bank DB |
| Identity (`identity`) | `data/secrets/identity.env` | **Service-token signing key** (Ed25519) and key id; server certificate `vaultpay-identity` + key; CA; risk-decision **public** key (Step 7) | identity DB, **read-only** (sessions, customers, wallets, merchants) |
| CBI (`cbi`) | `data/secrets/cbi.env` | Certificate `vaultpay-cbi` (server for VaultPay callers, client to the bank) + key; CA; service-token **public** key and key id; **Core Banking credential** | none |
| mock Core Banking | `data/secrets/mock-core-banking.env` | Server certificate `vaultpay-mock-core-banking` + key; CA; the Core Banking credential it expects | `mock-core-banking.db`, **read-write** (postings, Step 7) |
| Fraud & Risk Check (Step 6) | `data/secrets/fraud.env` | Risk-decision **signing** key (only here) and key id; server certificate `vaultpay-fraud` + key; CA; service-token public key and mock scoring key (unused so far) | **none** |
| Fraud worker – Orchestrator (Step 6) | `data/secrets/orchestrator.env` | Client certificate `vaultpay-orchestrator` + key; CA; risk-decision **public** key and key id | transaction DB, **read-write** (outbox claims, decisions, status changes) |
| Settlement (Step 7) | `data/secrets/settlement.env` | Client certificate `vaultpay-settlement` (to Identity, CBI) and server certificate `settlement-server` (CN `vaultpay-settlement`, for the worker) + keys; CA; risk-decision **public** key; service-token public key (unused) | **none** |
| Settlement worker – Orchestrator (Step 7) | `data/secrets/orchestrator.env` | Same as the fraud worker: client certificate `vaultpay-orchestrator`; risk-decision public key | transaction DB, **read-write** (attempts, status, ledger, audit, outbox) |
| Reconciliation & recovery (Step 8) | `data/secrets/recon.env` | Client certificate `vaultpay-recon` + key; CA. No key, no bank credential | transaction DB, **read-write** (reconciliation results, resolutions, expiry, requeue, audit) |
| `npm run setup` | all of `data/` | Creates everything; the CA private key is used only here | creates/migrates all databases |

Loaders (`lib/server/config.js` for web, `lib/services/process-env.js` for services)
refuse another process's file, links/junctions and certificate paths outside `data/pki`,
and never copy values into `process.env`. Tests fail if Next.js code imports the bank
client, a service, or another process's env file.

## 3. Customer balance flow (Step 4B)

1. The customer signs in **and completes MFA** in this session.
2. `/wallet` runs `requireCustomer()` (active customer, MFA in this session); the wallet
   must be active.
3. **Next.js → Identity** `POST /v1/service-tokens/customer-balance` with
   `{"sessionToken": "<the customer's Better Auth session token>"}` over mTLS
   (`CN=vaultpay-web`). The body has exactly that one field – there is no way to ask for a
   scope, audience, subject or account.
4. **Identity** looks the session up in its read-only identity DB and requires: session
   live; `mfaVerifiedAt` set within that session's lifetime; an **active customer**; that
   customer's wallet **active**. It takes `core_account_ref` from the wallet record and
   returns a signed token. Any failure: a generic `403`.
5. **Next.js → CBI** `GET /v1/balance` with `Authorization: Bearer <token>` over mTLS
   (`CN=vaultpay-web`). No account in the request (a query string is refused).
6. **CBI** verifies the token (section 4), then calls Core Banking for the account in the
   token over mTLS with its own certificate and credential.
7. CBI returns `{"walletId","balanceCents","currency","status","asOf"}`; Next.js checks
   the schema and that `walletId` is the viewer's own wallet, and renders only the amount.

Every failure – Identity or CBI unreachable or refusing, the bank down (`503`), an
account the bank does not know (`502`), a malformed response, a wallet mismatch – shows
*"Your balance is temporarily unavailable"*; the reason is logged on the server only. A
frozen/closed wallet shows *"Not available for a frozen or closed wallet."*

### Transfer initiation (Step 5)

Creating a transfer adds **no new token purpose, endpoint or credential**. At confirmation
the `/send` Server Action runs the balance flow above unchanged (a fresh single-use balance
token for the customer's own session) as a *preliminary* funds check, then writes the
transfer through the Orchestrator's transfer writer in the transaction database. Next.js
still has no access to the bank database, the bank credential or any signing key; if
Identity, CBI or the bank is unavailable, the transfer is refused (fail closed). Moving
money – the `corebanking.settlement:submit` purpose for `sub vaultpay-settlement` – is
Step 7 and not implemented. Fraud screening (section 3b) happens after acceptance, in the
fraud worker – never in the browser request.

## 3b. Fraud screening and signed decisions (Step 6)

1. A `fraud_check` outbox message exists for every new transfer (Step 5, same DB transaction).
2. **Claim:** a worker leases one due message in a `BEGIN IMMEDIATE` transaction
   (`status leased`, `lease_until` now + 30 s, `attempts + 1`). The new `attempts` value is
   its fencing token: all later writes require that exact value, so a worker that lost its
   lease (slow, or crashed and replaced) changes nothing. An expired lease is claimable again.
3. If the transfer is no longer `pending_risk` (duplicate delivery), the message is marked
   done – Fraud & Risk is not asked.
4. **Worker → Fraud & Risk** `POST /v1/risk-decisions` over mTLS (client
   `vaultpay-orchestrator`, server pinned to `vaultpay-fraud`) with the transfer exactly as
   stored – `{id, sender_wallet_id, payee_type, payee_id, amount_cents, currency}` – its
   `createdAt`, and `requestId = <message id>:<attempt>`.
5. **Fraud & Risk** validates the request (strict schema; anything else → `400`, nothing
   signed), runs the deterministic engine and returns `{"decision": "<JWS>"}`.
6. **Worker verifies** (lib/fraud/risk-decision.js) – any failure: not applied, audit event
   `risk.decision_rejected`, message retried later:

   | Check | Value |
   |-------|-------|
   | Signature | Ed25519 with the risk-decision public key; `alg EdDSA` only |
   | Header | `typ vaultpay-risk-decision+jwt`, `kid` = the expected risk-decision key id |
   | Claims | `iss vaultpay-fraud`, `aud vaultpay-orchestrator`, `sub` = transfer id, `jti` = `rsk_…` decision id, `iat`, `exp` (≤ 10 min, not expired), strict schema (no extra claims) |
   | Request binding | `req` = this attempt's request id (an older or another transfer's decision cannot be replayed) |
   | Transfer binding | `transfer` equals the database row field by field |
   | Outcome | `approve` or `decline`, integer `risk_score` 0–1000, reason codes |

7. **Apply** (one `BEGIN IMMEDIATE` transaction, fenced): insert `risk_decision` (the
   decision id is the primary key – a decision applies once), `pending_risk →
   pending_settlement` (approve) or `→ declined`, audit `transfer.risk_approved` /
   `transfer.risk_declined`, a `settlement` outbox message for an approval, then the
   `fraud_check` message → `done`. A failure rolls all of it back.

Network errors, non-200 answers and invalid decisions leave the transfer `pending_risk`:
retry after 1 s, 2 s, 4 s … (max 60 s); after 10 attempts the message is `dead` (transfer
still `pending_risk`). A successful network call never approves anything by itself.

This link uses mTLS identities and a signed response, not an Identity service token: the
caller's only power is to ask for a decision on a transfer, and what is applied is decided
by the worker's own database row and the signature – not by anything the caller asserts.

## 3c. Settlement (Step 7)

1. **Claim** a due `settlement` outbox message (lease + fencing, exactly as in 3b).
2. Transfer `pending_settlement`: re-verify the stored approval against the transfer row
   (signature, binding, approve, ≥ 60 s validity left). Expired or invalid → **re-screen**:
   `pending_settlement → pending_risk`, new `fraud_check` message, audit
   `transfer.risk_rescreen` – nothing goes to the bank.
3. Otherwise, **before anything leaves** (D5), one transaction: `→ settlement_in_flight`
   with `settlement_attempted_at`, a `settlement_attempt` (outcome `pending`) with a fresh
   bank idempotency key `stlk_…`, audit `transfer.settlement_started`.
   A transfer already `settlement_in_flight` (retry, crash, timeout) reuses its open
   attempt and **the same key**.
4. **Worker → Settlement** `POST /v1/settlements` `{transfer (from the DB row), idempotencyKey, riskDecision}`.
5. **Settlement** verifies the approval for exactly this transfer, then **→ Identity**
   `POST /v1/service-tokens/settlement` `{riskDecision, idempotencyKey}`. Identity
   re-verifies the approval (its own risk-decision public key), takes transfer id,
   parties, amount and currency from the signed approval, maps the wallets/merchant to bank
   accounts from its own records (active customer, active wallet/merchant) and signs a
   token for that one posting. The caller cannot name an account, amount, scope or audience.
6. **Settlement → CBI** `POST /v1/postings` with the token and **no body**. CBI verifies the
   token (section 4) and sends the bank exactly the posting it names.
7. **Mock bank** (one `BEGIN IMMEDIATE` transaction): an existing posting with that
   idempotency key → returned as it was (a different payload → `409`); else both accounts
   active (also a DB trigger) and funds sufficient (also `balance_cents >= 0`) → debit,
   credit and posting row together. `422` refusals are definitive: nothing moved.
8. **Worker applies** the answer (fenced, one transaction each):

   | Answer | Effect |
   |--------|--------|
   | `settled` + posting ref | attempt `settled` with the ref, transfer `completed`, ledger debit + credit (with the ref), audit `transfer.settled`, message done |
   | `rejected` (bank) | definitive **only** for an attempt created in this claim (its key was sent exactly once): attempt `failed`, transfer `failed`, audit `transfer.settlement_failed`, message done. After an earlier unanswered send, like unknown – the earlier request could still post |
   | `refused` (before the bank) | definitive **only** for an attempt created in this claim (its key was never sent); otherwise like unknown |
   | `unknown`, `not_sent`, timeout, no answer | attempt `unknown`, transfer stays `settlement_in_flight`, audit `transfer.settlement_unknown`, retry with the same key (1 s … 60 s) |

   Still unknown when the approval has expired: the same key cannot be resubmitted, so the
   message is parked `dead` with `needs_reconciliation`; the transfer stays in flight.

**Database guards (migration 0005):** `completed` needs a settled attempt with a bank
reference; `failed` needs a failed attempt and no open or settled one; a ledger posting must
carry its transfer's settled bank reference; a credit needs its matching debit; a completed
transfer's settlement message cannot be finished without exactly one debit and one credit;
`ledger_totals` reports debits and credits.

## 3d. Reconciliation (Step 8)

Candidates: `settlement_in_flight` transfers with an open attempt (`pending`/`unknown`)
older than 2 minutes and no unexpired lease on their messages.

1. **Reconciliation → Identity** `POST /v1/service-tokens/reconciliation` with the
   transfer's id, the attempt's idempotency key, sender, payee, amount and currency (from the
   transaction DB). Identity maps the wallets/merchant to bank accounts from its own records
   (whatever their status now) and signs a token: `sub vaultpay-recon`, `scope
   corebanking.records:read`, claims `transfer_id`, `idempotency_key`, `debit_account`,
   `credit_account`, `amount_cents`, `currency`; 30 s, certificate-bound, single use.
2. **Reconciliation → CBI** `POST /v1/postings/lookup` with the token and **no body**. CBI
   asks the bank for the posting with that key (`GET /v1/postings/{key}`, read-only) and
   compares transfer id, both accounts, amount and currency with the token. It answers only
   `posted` + posting reference, `not_found`, `mismatch` or (`504`) `unknown` – never an
   account.
3. **Apply** (one `BEGIN IMMEDIATE` transaction, re-checking that the attempt is still open
   and unleased): `posted` → attempt settled, transfer completed, one ledger pair, result
   `matched`, live settlement message closed; `not_found` → **left unresolved** (audit
   `reconciliation.unresolved`, funds reserved): a request with that key may still be inside
   the bank, so absence is never turned into `failed` (Step 9 review);
   `mismatch` → result `mismatched` (once) and left in flight; anything else → audit
   `reconciliation.unresolved`, nothing changes.

The lookup cannot post: a records token is refused at `/v1/postings`, a settlement token at
`/v1/postings/lookup`, and only `vaultpay-recon` may call either the lookup or its Identity
endpoint. Concurrent reconcilers are safe: the bank call is read-only, and only one
transaction can move the attempt out of `pending`/`unknown`.

## 4. Service tokens

**Issuer:** the Identity service only. **Format:** compact JWS, `alg: EdDSA` (Ed25519) only,
protected header `{ "alg": "EdDSA", "typ": "vaultpay-service+jwt", "kid": "<SERVICE_TOKEN_KEY_ID>" }`.

| Claim | Customer balance token | Rule at CBI |
|-------|------------------------|-------------|
| `iss` | `vaultpay-identity` | exact |
| `aud` | `vaultpay-cbi` | must be CBI |
| `sub` | `vaultpay-web` (the caller Identity authenticated) | must equal the mTLS peer CN |
| `cnf` | `{ "x5t#S256": SHA-256 thumbprint of the caller's client certificate }` | must equal the presented certificate (RFC 8705) |
| `iat`, `exp` | `exp = iat + 30 s` | ≤ 60 s lifetime and age; 5 s clock skew |
| `jti` | 128-bit random | **single use** – remembered until expiry (bounded cache; when full, new tokens are refused rather than old ones forgotten) |
| `scope` | `corebanking.balance:read` | allowed for that `sub` (`vaultpay-web` → balance read only) |
| `account_ref`, `wallet_id` | from Identity's wallet record | `account_ref` must be a valid bank reference; CBI reads only this account |

**Settlement token** (Step 7): same header, `iss`, `aud vaultpay-cbi`, `cnf`, 30 s and
single-use `jti` rules; `sub vaultpay-settlement`; `scope corebanking.settlement:submit`;
claims `transfer_id`, `debit_account`, `credit_account`, `amount_cents`, `currency`,
`idempotency_key`, `decision_id` – all chosen by Identity from the verified approval and
its own records except the idempotency key. CBI accepts it only at `POST /v1/postings`
from `vaultpay-settlement`, with no request body, and forwards exactly these values. A
settlement token cannot read balances, a balance token cannot post, and neither caller can
use the other's endpoint.

**Verification order at CBI:** caller CN allowlist (TLS) → signature with the `kid`'s
public key, `alg`, `typ` → `iss`, `aud`, `exp`/`iat`/age → `sub` = peer CN → `cnf` = peer
certificate → `scope` for `sub` → required claims → `jti` unused. Failures answer `401`
(`{"error":"unauthorized"}`) or `403` (`{"error":"forbidden"}`) without saying which check
failed.

**Scopes:** `corebanking.balance:read` (`vaultpay-web`), `corebanking.settlement:submit`
(`vaultpay-settlement`) and `corebanking.records:read` (`vaultpay-recon`, Step 8 – one
posting lookup by key), each with its own purpose-specific Identity endpoint and CBI route,
never a generic one.

**Rotation:** `kid` identifies the key; `npm run setup -- --rotate-secrets` replaces it.

**Limits:** a compromised Next.js process can obtain balance tokens only for customers
whose live, MFA-verified session tokens it sees – not for arbitrary accounts. A
compromise of the Identity process can mint any token. The replay cache is per CBI
process (in memory).

## 5. Internal endpoints

| Service | Endpoint | Callers | Errors |
|---------|----------|---------|--------|
| Identity | `POST /v1/service-tokens/customer-balance` | `vaultpay-web` | 400 `invalid_request`, 403 `forbidden`, 404, 405 |
| Identity | `POST /v1/service-tokens/settlement` | `vaultpay-settlement` | 400 `invalid_request`, 403 `forbidden`, 404, 405 |
| CBI | `GET /v1/balance` | `vaultpay-web` | 400 `invalid_request`, 401 `unauthorized`, 403 `forbidden`, 502 `upstream_error`, 503 `unavailable` |
| CBI | `POST /v1/postings` (no body) | `vaultpay-settlement` | 400, 401, 403, 422 `{outcome:"rejected"}`, 504 `{outcome:"unknown"}` |
| mock Core Banking | `GET /v1/accounts/{MCB-…}/balance` | `vaultpay-cbi` + credential | 400 `invalid_account`/`invalid_request`, 401, 403, 404 `not_found`, 405 |
| mock Core Banking | `POST /v1/postings` | `vaultpay-cbi` + credential | 400, 401, 403, 409 `idempotency_conflict`, 422 `insufficient_funds`/`account_inactive`/`account_not_found` |
| Settlement | `POST /v1/settlements` | `vaultpay-orchestrator` | 400 `invalid_request`, 401, 403, 404, 405; results as `{outcome}` (section 3c) |
| Identity | `POST /v1/service-tokens/reconciliation` | `vaultpay-recon` | 400 `invalid_request`, 403 `forbidden`, 404, 405 |
| CBI | `POST /v1/postings/lookup` (no body) | `vaultpay-recon` | 400, 401, 403; 200 `{status}`; 504 `{status:"unknown"}` |
| mock Core Banking | `GET /v1/postings/{stlk_…}` | `vaultpay-cbi` + credential | 401, 403, 404 `not_found` |
| Fraud & Risk | `POST /v1/risk-decisions` | `vaultpay-orchestrator` | 400 `invalid_request`, 401, 403 `forbidden`, 404, 405 |

All: JSON, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, request and header
timeouts, small bodies only; no stack traces, paths, SQL or echoed input.

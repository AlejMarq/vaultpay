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
| Next.js (`web`) | `data/secrets/web.env` | Better Auth secret; client certificate `vaultpay-web` + key; Reconciliation client certificate `vaultpay-recon` + key (for later); CA. **No signing key, no Core Banking credential** | identity DB (Better Auth: read-write; DAL and support: read-only); transaction DB (read-only; separate append-only audit writer). **Never** the mock bank DB |
| Identity (`identity`) | `data/secrets/identity.env` | **Service-token signing key** (Ed25519) and key id; server certificate `vaultpay-identity` + key; CA | identity DB, **read-only** (sessions, customers, wallets) |
| CBI (`cbi`) | `data/secrets/cbi.env` | Certificate `vaultpay-cbi` (server for VaultPay callers, client to the bank) + key; CA; service-token **public** key and key id; **Core Banking credential** | none |
| mock Core Banking | `data/secrets/mock-core-banking.env` | Server certificate `vaultpay-mock-core-banking` + key; CA; the Core Banking credential it expects | `mock-core-banking.db` (read-only so far) |
| Settlement (Step 5) | `data/secrets/settlement.env` | Client certificate `vaultpay-settlement` + key; CA; risk-decision public key; service-token public key | none |
| Fraud & Risk Check (Step 5) | `data/secrets/fraud.env` | Risk-decision **signing** key; service-token public key; mock scoring key | none |
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

**Verification order at CBI:** caller CN allowlist (TLS) → signature with the `kid`'s
public key, `alg`, `typ` → `iss`, `aud`, `exp`/`iat`/age → `sub` = peer CN → `cnf` = peer
certificate → `scope` for `sub` → required claims → `jti` unused. Failures answer `401`
(`{"error":"unauthorized"}`) or `403` (`{"error":"forbidden"}`) without saying which check
failed.

**Scopes:** `corebanking.balance:read` (implemented). Planned: `corebanking.records:read`
for Reconciliation (`sub vaultpay-recon`) and `corebanking.settlement:submit` for
Settlement (`sub vaultpay-settlement`, bound to transfer, amount, currency and idempotency
key) – each with its own purpose-specific Identity endpoint, never a generic one.

**Rotation:** `kid` identifies the key; `npm run setup -- --rotate-secrets` replaces it.

**Limits:** a compromised Next.js process can obtain balance tokens only for customers
whose live, MFA-verified session tokens it sees – not for arbitrary accounts. A
compromise of the Identity process can mint any token. The replay cache is per CBI
process (in memory).

## 5. Internal endpoints

| Service | Endpoint | Callers | Errors |
|---------|----------|---------|--------|
| Identity | `POST /v1/service-tokens/customer-balance` | `vaultpay-web` | 400 `invalid_request`, 403 `forbidden`, 404, 405 |
| CBI | `GET /v1/balance` | `vaultpay-web` | 400 `invalid_request`, 401 `unauthorized`, 403 `forbidden`, 502 `upstream_error`, 503 `unavailable` |
| mock Core Banking | `GET /v1/accounts/{MCB-…}/balance` | `vaultpay-cbi` + credential | 400 `invalid_account`/`invalid_request`, 401, 403, 404 `not_found`, 405 |

All: JSON, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, request and header
timeouts, small bodies only; no stack traces, paths, SQL or echoed input.

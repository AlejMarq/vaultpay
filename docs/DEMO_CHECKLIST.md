# VaultPay – Final Demonstration Checklist

Run in PowerShell from the project folder with **Node 22.23.3** active. Expected results
assume a **fresh installation** (Alice $500.00, Bob $250.00). On an installation that was
used before, balances differ by earlier transfers – check the starting balance in step 2.

Never reset an installation you want to keep. For a clean demo on a separate copy, set
`$env:VAULTPAY_DATA_DIR` to an empty folder **in every terminal** before `npm.cmd run setup`.

## 0. Preparation

| # | Command / action | Expected result |
|---|------------------|-----------------|
| 0.1 | `node -v` | `v22.23.3` |
| 0.2 | `npm.cmd run setup` then `npm.cmd run setup:check` | `Setup complete.` / every line `PASS`, `Installation check passed` |
| 0.3 | Terminal 1: `npm.cmd run services` | five `listening on https://127.0.0.1:…` lines (4100–4500), then `All services running` |
| 0.4 | Terminal 2: `npm.cmd run dev` | app at `http://localhost:3000` |

## 1. Alice signs in with MFA

| # | Action | Expected result |
|---|--------|-----------------|
| 1.1 | Open `http://localhost:3000`, sign in as `alice@example.test` / `VaultPayDemo-Alice-1!` | First time: TOTP enrollment (password again, QR code, first code, backup codes shown once). Later: code prompt |
| 1.2 | Enter the authenticator code | `/wallet`: Alice Demo, KYC *Approved*, wallet `wal_demo_alice`, **balance $500.00** |
| 1.3 | (optional) Same code a second time in another sign-in | refused (replay protection) |

## 2. Alice sends a small transfer to Bob

| # | Action | Expected result |
|---|--------|-----------------|
| 2.1 | *Send money* → recipient `bob@example.test`, amount `12.50` → *Review transfer* | Confirmation: from `wal_demo_alice`, to `bob@example.test`, **$12.50** |
| 2.2 | *Confirm and send* | "Transfer submitted – **Pending – security check**", a `trf_…` reference |
| 2.3 | *Back to your wallet* | the transfer listed as *Pending – security check*; *Pending outgoing $12.50*; balance still $500.00 (nothing moved yet) |

## 3. High-risk transfer

| # | Action | Expected result |
|---|--------|-----------------|
| 3.1 | Send `300.00` to `bob@example.test` (review, confirm) | *Pending – security check* |

## 4. Fraud screening

| # | Command | Expected result |
|---|---------|-----------------|
| 4.1 | Terminal 3: `npm.cmd run fraud-worker -- --once` | `[fraud-worker] done: pending_settlement=1 declined=1` |
| 4.2 | Reload `/wallet` | $12.50 → *Pending – awaiting settlement*; $300.00 → **Declined**; pending outgoing $12.50 |

## 5. Settlement

| # | Command | Expected result |
|---|---------|-----------------|
| 5.1 | `npm.cmd run settlement-worker -- --once` | `[settlement-worker] done: completed=1` |
| 5.2 | Reload Alice's `/wallet` | $12.50 → **Completed**; **balance $487.50**; no pending outgoing |
| 5.3 | Sign out; sign in as `bob@example.test` / `VaultPayDemo-Bob-1!` (+ TOTP) | **balance $262.50**; the transfer listed as received, *Completed* |

## 6. Ledger

| # | Command / action | Expected result |
|---|------------------|-----------------|
| 6.1 | `npm.cmd run reconcile -- --once` | `… nothing to reconcile integrity_issues=0` |
| 6.2 | Sign in as `support@example.test` / `VaultPayDemo-Support-1!` (+ TOTP) → *Operations overview* | *Ledger integrity*: Debits $12.50 · Credits $12.50 · 2 entries – **balanced**, no issues |

## 7. Support operations dashboard

| # | Action | Expected result |
|---|--------|-----------------|
| 7.1 | `/operations` as support | counts: Completed 1, Declined 1; outbox table; no parked messages; no open outcomes; no exceptions |
| 7.2 | Look at the page | only transfer ids and totals – no bank accounts, emails, names, wallet ids, keys or tokens; no buttons besides *Sign out* |
| 7.3 | Open `/operations` as Alice | *Access denied* |
| 7.4 | `/support` → look up `alice@example.test` | masked email/phone, KYC, wallet, transfers (read-only; audited) |
| 7.5 | (optional) Carol: sign in → `/send` | "identity verification (KYC) is still pending" – no form |

## 8. Reconciliation recovery (bank posts, answer lost)

| # | Command / action | Expected result |
|---|------------------|-----------------|
| 8.1 | Terminal 1: Ctrl+C (stops all services) | services stopped |
| 8.2 | Terminal 1: `$env:VAULTPAY_MOCK_BANK_POST_DELAY_MS='4500'; npm.cmd run mock-bank` | mock bank listening on 4100 (answers postings 4.5 s late, after committing) |
| 8.3 | Terminal 4: `npm.cmd run identity`; terminal 5: `npm.cmd run cbi`; terminal 6: `npm.cmd run fraud`; terminal 7: `npm.cmd run settlement` | each `listening on https://127.0.0.1:…` |
| 8.4 | As Alice send `5.00` to Bob; `npm.cmd run fraud-worker -- --once` | `pending_settlement=1` |
| 8.5 | `npm.cmd run settlement-worker -- --once` | `retry=1`; `/wallet` shows the $5.00 transfer as **Processing**, balance already **$482.50** (the bank did post) |
| 8.6 | Terminal 1: Ctrl+C, then `$env:VAULTPAY_MOCK_BANK_POST_DELAY_MS=''; npm.cmd run mock-bank` | bank answers normally again |
| 8.7 | Support: `/operations` | the transfer under *Settlements with an open outcome* (`unknown`) |
| 8.8 | `$env:VAULTPAY_RECONCILE_MIN_AGE_MS='1000'; npm.cmd run reconcile -- --once` (or wait 2 minutes without the variable) | `completed=1 … integrity_issues=0` (if the settlement worker ran first it may already be completed – both use the same key, one posting) |
| 8.9 | Alice `/wallet`; support `/operations` | $5.00 **Completed**, balance $482.50 (money moved once); ledger Debits $17.50 = Credits $17.50, *balanced*; a `matched` reconciliation result |

## Automated equivalent

`npm.cmd run test:settlement` (steps 2–6 on real processes, fresh install) and
`npm.cmd run test:reconcile` (step 8 and the outage/expiry cases) – both end with
`ALL … CHECKS PASSED`; `npm.cmd run test:http` covers steps 1–7 through the web UI.

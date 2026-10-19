// All VaultPay services in-process over real mTLS (Steps 7–8): mock bank (writable),
// Identity, CBI (servicesHarness), Fraud & Risk, Settlement – plus both outbox workers with
// an injectable clock, a transfer writer and state readers.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { engineConfig } from '../../lib/fraud/engine.js';
import { createFraudWorker } from '../../lib/orchestrator/fraud-worker.js';
import { createSettlementWorker } from '../../lib/orchestrator/settlement-worker.js';
import { openMockCoreBankingDb } from '../../lib/server/db/index.js';
import { createTransferWriter } from '../../lib/server/transfer-orchestrator.js';
import { mtlsRequest } from '../../lib/services/mtls-request.js';
import { loadProcessEnv } from '../../lib/services/process-env.js';
import { privateKeyFrom, publicKeyFrom } from '../../lib/services/service-token.js';
import { createFraudServer } from '../../services/fraud/app.js';
import { createSettlementServer } from '../../services/settlement/app.js';
import { onCleanup } from './db.mjs';
import { servicesHarness } from './services.mjs';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// ---------------------------------------------------------------------------
// Harness: every service in-process over real mTLS on a temporary installation –
// mock bank (writable), Identity, CBI (servicesHarness), Fraud & Risk, Settlement –
// plus both outbox workers with injectable clocks.
// ---------------------------------------------------------------------------
export async function settlementHarness(t, { engine = {} } = {}) {
  // CBI gives the bank 3 s (as in production), so postings are not "unknown" just because a busy test machine is slow.
  const s = await servicesHarness(t, { bankTimeoutMs: 3000 });
  const { dataDir } = s;
  const fraudEnv = loadProcessEnv('fraud', { dataDir });
  const orchestrator = loadProcessEnv('orchestrator', { dataDir });
  const settlementEnv = loadProcessEnv('settlement', { dataDir, serverTls: true });
  const riskKeyId = fraudEnv.values.RISK_DECISION_KEY_ID;
  const riskSigningKey = privateKeyFrom(fraudEnv.values.RISK_DECISION_SIGNING_KEY);
  const riskPublicKey = publicKeyFrom(orchestrator.values.RISK_DECISION_PUBLIC_KEY);

  let offset = 0;
  const clock = { now: () => Date.now() + offset, advance: (ms) => { offset += ms; } };
  const fraud = createFraudServer({ tls: fraudEnv.tls, signingKey: riskSigningKey, keyId: riskKeyId, config: engineConfig(engine) });
  const fraudPort = await listen(fraud);
  const settlementLog = [];
  const settlement = createSettlementServer({
    serverTls: settlementEnv.serverTls, clientTls: settlementEnv.tls, riskPublicKey, riskKeyId,
    identityPort: s.identityPort, cbiPort: s.cbiPort, cbiTimeoutMs: 4000, log: (m) => settlementLog.push(m),
  });
  const settlementPort = await listen(settlement);
  for (const srv of [fraud, settlement]) onCleanup(t, () => (srv.listening ? s.close(srv) : undefined));

  const bankRo = openMockCoreBankingDb({ dataDir, readonly: true });
  onCleanup(t, () => bankRo.close());
  const writer = createTransferWriter(s.transactionRw);
  const logs = [];
  const requestSettlement = (body) => mtlsRequest({ port: settlementPort, method: 'POST', path: '/v1/settlements', credentials: orchestrator.tls, expectedServer: 'vaultpay-settlement', body, timeoutMs: 8000 });
  const fraudWorker = (extra = {}) => createFraudWorker({
    db: s.transactionRw, publicKey: riskPublicKey, keyId: riskKeyId,
    requestDecision: (body) => mtlsRequest({ port: fraudPort, method: 'POST', path: '/v1/risk-decisions', credentials: orchestrator.tls, expectedServer: 'vaultpay-fraud', body }),
    ...extra,
  });
  const settler = ({ connection, ...extra } = {}) => createSettlementWorker({
    db: connection ?? s.transactionRw, publicKey: riskPublicKey, keyId: riskKeyId, requestSettlement, now: clock.now, log: (m) => logs.push(m), ...extra,
  });

  let seq = 0;
  const transfer = (amountCents, { from = 'wal_demo_alice', to = 'wal_demo_bob', customer = 'cus_demo_alice' } = {}) => writer.create({
    customerId: customer, senderWalletId: from, recipientWalletId: to, amountCents, currency: 'USD',
    idempotencyKey: `settle-test-${(seq += 1)}-${crypto.randomBytes(4).toString('hex')}`, balanceCents: 10_000_000,
  }).transfer.transferId;
  const bankBalance = (ref) => bankRo.prepare('SELECT balance_cents FROM account WHERE account_ref = ?').get(ref).balance_cents;
  const ro = s.transactionRo;
  const state = (id) => ({
    status: ro.prepare('SELECT status FROM transfer WHERE transfer_id = ?').get(id).status,
    attempts: ro.prepare('SELECT outcome, core_banking_ref, idempotency_key FROM settlement_attempt WHERE transfer_id = ? ORDER BY attempt_no').all(id),
    ledger: ro.prepare('SELECT account_type, account_id, direction, amount_cents, core_banking_ref FROM ledger_entry WHERE transfer_id = ? ORDER BY direction DESC').all(id),
    audit: ro.prepare("SELECT event_type FROM audit_event WHERE transfer_id = ? ORDER BY rowid").all(id).map((r) => r.event_type),
    outbox: ro.prepare('SELECT target, status, last_error FROM outbox_message WHERE transfer_id = ? ORDER BY rowid').all(id).map((m) => `${m.target}:${m.status}`),
  });
  const postings = (id) => bankRo.prepare('SELECT posting_ref, idempotency_key, debit_account, credit_account, amount_cents FROM posting WHERE reference = ?').all(id);
  return {
    ...s, fraudEnv, orchestrator, settlementEnv, riskKeyId, riskSigningKey, riskPublicKey, fraudPort, settlementPort, settlementLog,
    writer, clock, logs, requestSettlement, fraudWorker, settler, transfer, bankBalance, state, postings, bankRo,
    approved: async (amount, opts) => {
      const id = transfer(amount, opts);
      await fraudWorker().runOnce();
      assert.equal(state(id).status, 'pending_settlement');
      return id;
    },
  };
}

export const ledgerTotals = (h) => h.transactionRo.prepare('SELECT debit_cents, credit_cents, entries FROM ledger_totals').get();

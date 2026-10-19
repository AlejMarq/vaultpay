// npm run settlement-worker – the Orchestrator's settlement outbox worker as its own process (Step 7).
//
//   npm run settlement-worker              keep running: settle due transfers every 2 s
//   npm run settlement-worker -- --once    settle everything due now, print a summary, exit
//
// Owns: data/secrets/orchestrator.env – the risk-decision PUBLIC key and its client
// certificate (CN=vaultpay-orchestrator) – and a writable connection to the transaction
// database. Calls the Settlement service at 127.0.0.1:VAULTPAY_SETTLEMENT_PORT (default
// 4500). Holds no bank credential and no signing key. Several workers may run at once.
// VAULTPAY_SETTLEMENT_LEASE_MS (tests/demo, 5000–600000; default 60000): how long a claim
// is held before another worker may take over a crashed one.

import { createSettlementWorker } from '../../lib/orchestrator/settlement-worker.js';
import { defaultDataDir } from '../../lib/server/db/definitions.js';
import { openTransactionDb } from '../../lib/server/db/index.js';
import { mtlsRequest } from '../../lib/services/mtls-request.js';
import { servicePort } from '../../lib/services/ports.js';
import { loadProcessEnv, requireNode22 } from '../../lib/services/process-env.js';
import { publicKeyFrom } from '../../lib/services/service-token.js';

requireNode22();

const once = process.argv.includes('--once');
const dataDir = defaultDataDir();
let config;
let db;
let publicKey;
try {
  config = loadProcessEnv('orchestrator', { dataDir, required: ['RISK_DECISION_PUBLIC_KEY', 'RISK_DECISION_KEY_ID'] });
  publicKey = publicKeyFrom(config.values.RISK_DECISION_PUBLIC_KEY);
  db = openTransactionDb({ dataDir });
} catch (err) {
  console.error(`Settlement worker cannot start: ${err.code ?? 'ERROR'} – ${err.message}`);
  process.exit(1);
}

const port = servicePort('settlement');
const leaseSetting = Number(process.env.VAULTPAY_SETTLEMENT_LEASE_MS);
const leaseMs = Number.isInteger(leaseSetting) && leaseSetting >= 5000 && leaseSetting <= 600_000 ? leaseSetting : undefined;
const worker = createSettlementWorker({
  db,
  publicKey,
  keyId: config.values.RISK_DECISION_KEY_ID,
  leaseMs,
  // Longer than Settlement's own Identity (3 s) + CBI (6 s) deadlines.
  requestSettlement: (body) => mtlsRequest({
    port, method: 'POST', path: '/v1/settlements', credentials: config.tls, expectedServer: 'vaultpay-settlement', body, timeoutMs: 12_000,
  }),
  log: (msg) => console.log(`[settlement-worker] ${msg}`),
});

const summary = (counts) => Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing due';

if (once) {
  const counts = await worker.runOnce();
  console.log(`[settlement-worker] done: ${summary(counts)}`);
  db.close();
} else {
  console.log(`[settlement-worker] running (Settlement at 127.0.0.1:${port}); Ctrl+C stops`);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    const counts = await worker.runOnce();
    if (Object.keys(counts).length) console.log(`[settlement-worker] ${summary(counts)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  db.close();
}

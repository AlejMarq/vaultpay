// npm run fraud-worker – the Orchestrator's fraud outbox worker as its own process (Step 6).
//
//   npm run fraud-worker              keep running: process due fraud_check messages every 2 s
//   npm run fraud-worker -- --once    process everything due now, print a summary, exit
//
// Owns: data/secrets/orchestrator.env – the risk-decision PUBLIC key (it verifies, never
// signs) and its client certificate (CN=vaultpay-orchestrator) – and a writable connection
// to the transaction database. Calls Fraud & Risk Check at 127.0.0.1:VAULTPAY_FRAUD_PORT
// (default 4400). Several workers may run at once: claims and leases are in the database.

import { createFraudWorker } from '../../lib/orchestrator/fraud-worker.js';
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
  console.error(`Fraud worker cannot start: ${err.code ?? 'ERROR'} – ${err.message}`);
  process.exit(1);
}

const port = servicePort('fraud');
const worker = createFraudWorker({
  db,
  publicKey,
  keyId: config.values.RISK_DECISION_KEY_ID,
  requestDecision: (body) => mtlsRequest({
    port, method: 'POST', path: '/v1/risk-decisions', credentials: config.tls, expectedServer: 'vaultpay-fraud', body, timeoutMs: 3000,
  }),
  log: (msg) => console.log(`[fraud-worker] ${msg}`),
});

const summary = (counts) => Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing due';

if (once) {
  const counts = await worker.runOnce();
  console.log(`[fraud-worker] done: ${summary(counts)}`);
  db.close();
} else {
  console.log(`[fraud-worker] running (Fraud & Risk at 127.0.0.1:${port}); Ctrl+C stops`);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    const counts = await worker.runOnce();
    if (Object.keys(counts).length) console.log(`[fraud-worker] ${summary(counts)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  db.close();
}

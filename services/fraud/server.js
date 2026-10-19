// npm run fraud – the Fraud & Risk Check service as its own Node.js process (Step 6).
//
// Owns: data/secrets/fraud.env – the ONLY copy of the risk-decision signing key – and its
// server certificate (CN=vaultpay-fraud). No database. Listens on 127.0.0.1 only.
// Port: VAULTPAY_FRAUD_PORT (default 4400; 0 = any free port, used by tests).
// Demo thresholds: VAULTPAY_FRAUD_DECLINE_AT_CENTS, VAULTPAY_FRAUD_BLOCKED_PAYEES (lib/fraud/engine.js).

import { engineConfig } from '../../lib/fraud/engine.js';
import { defaultDataDir } from '../../lib/server/db/definitions.js';
import { servicePort, SERVICE_HOST } from '../../lib/services/ports.js';
import { loadProcessEnv, requireNode22 } from '../../lib/services/process-env.js';
import { privateKeyFrom } from '../../lib/services/service-token.js';

import { createFraudServer, FRAUD_CLIENTS } from './app.js';

requireNode22();

let config;
let signingKey;
let rules;
try {
  config = loadProcessEnv('fraud', { dataDir: defaultDataDir(), required: ['RISK_DECISION_SIGNING_KEY', 'RISK_DECISION_KEY_ID'] });
  signingKey = privateKeyFrom(config.values.RISK_DECISION_SIGNING_KEY);
  rules = engineConfig();
} catch (err) {
  console.error(`Fraud & Risk service cannot start: ${err.code ?? 'ERROR'} – ${err.message}`);
  process.exit(1);
}

const server = createFraudServer({
  tls: config.tls,
  signingKey,
  keyId: config.values.RISK_DECISION_KEY_ID,
  config: rules,
  log: (msg) => console.log(`[fraud] ${msg}`),
});

server.listen(servicePort('fraud'), SERVICE_HOST, () => {
  const { address, port } = server.address();
  console.log(`[fraud] listening on https://${address}:${port} (mTLS, clients: ${FRAUD_CLIENTS.join(', ')}; declines at ${rules.declineAtCents} cents)`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

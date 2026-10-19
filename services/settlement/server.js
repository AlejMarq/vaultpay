// npm run settlement – the Settlement service as its own Node.js process (Step 7).
//
// Owns: data/secrets/settlement.env – client certificate vaultpay-settlement (to Identity
// and CBI), server certificate vaultpay-settlement (for the settlement worker), the
// risk-decision PUBLIC key. No bank credential, no signing key, no database.
// Listens on 127.0.0.1 only. Port: VAULTPAY_SETTLEMENT_PORT (default 4500; 0 = any free port).
// Reaches Identity at VAULTPAY_IDENTITY_PORT (4200) and CBI at VAULTPAY_CBI_PORT (4300).

import { defaultDataDir } from '../../lib/server/db/definitions.js';
import { servicePort, SERVICE_HOST } from '../../lib/services/ports.js';
import { loadProcessEnv, requireNode22 } from '../../lib/services/process-env.js';
import { publicKeyFrom } from '../../lib/services/service-token.js';

import { createSettlementServer, SETTLEMENT_CLIENTS } from './app.js';

requireNode22();

let config;
let riskPublicKey;
try {
  config = loadProcessEnv('settlement', { dataDir: defaultDataDir(), serverTls: true, required: ['RISK_DECISION_PUBLIC_KEY', 'RISK_DECISION_KEY_ID'] });
  riskPublicKey = publicKeyFrom(config.values.RISK_DECISION_PUBLIC_KEY);
} catch (err) {
  console.error(`Settlement service cannot start: ${err.code ?? 'ERROR'} – ${err.message}`);
  process.exit(1);
}

const server = createSettlementServer({
  serverTls: config.serverTls,
  clientTls: config.tls,
  riskPublicKey,
  riskKeyId: config.values.RISK_DECISION_KEY_ID,
  identityPort: servicePort('identity'),
  cbiPort: servicePort('cbi'),
  log: (msg) => console.log(`[settlement] ${msg}`),
});

server.listen(servicePort('settlement'), SERVICE_HOST, () => {
  const { address, port } = server.address();
  console.log(`[settlement] listening on https://${address}:${port} (mTLS, clients: ${SETTLEMENT_CLIENTS.join(', ')})`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// npm run cbi – Core Banking Integration as its own Node.js process (Step 4B).
//
// Owns: data/secrets/cbi.env – its certificate (server for VaultPay callers, client to Core
// Banking), the service-token PUBLIC key, and the Core Banking credential. No database.
// Listens on 127.0.0.1 only. Port: VAULTPAY_CBI_PORT (default 4300; 0 = any free port).
// Reaches mock Core Banking at VAULTPAY_MOCK_BANK_PORT (default 4100).

import { loadCoreBankingClient } from '../../lib/cbi/core-banking-client.js';
import { defaultDataDir } from '../../lib/server/db/definitions.js';
import { servicePort, SERVICE_HOST } from '../../lib/services/ports.js';
import { loadProcessEnv, requireNode22 } from '../../lib/services/process-env.js';
import { createReplayCache, publicKeyFrom } from '../../lib/services/service-token.js';

import { createCbiServer } from './app.js';

requireNode22();

const dataDir = defaultDataDir();
let config;
let bank;
let tokenPublicKey;
try {
  config = loadProcessEnv('cbi', { dataDir, required: ['SERVICE_TOKEN_PUBLIC_KEY', 'SERVICE_TOKEN_KEY_ID', 'MOCK_CORE_BANKING_API_KEY'] });
  tokenPublicKey = publicKeyFrom(config.values.SERVICE_TOKEN_PUBLIC_KEY);
  bank = loadCoreBankingClient({ dataDir });
} catch (err) {
  console.error(`CBI cannot start: ${err.code ?? 'ERROR'} – ${err.message}`);
  process.exit(1);
}

const server = createCbiServer({
  tls: config.tls,
  tokenPublicKey,
  keyId: config.values.SERVICE_TOKEN_KEY_ID,
  bank,
  replayCache: createReplayCache(),
  log: (msg) => console.log(`[cbi] ${msg}`),
});

server.listen(servicePort('cbi'), SERVICE_HOST, () => {
  const { address, port } = server.address();
  console.log(`[cbi] listening on https://${address}:${port} (mTLS, clients: vaultpay-web → balance, vaultpay-settlement → postings, vaultpay-recon → posting lookup)`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

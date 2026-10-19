// npm run mock-bank – the mock Core Banking service as its own Node.js process.
//
// Owns: data/secrets/mock-core-banking.env (its server certificate/key, the CA, and the
// credential CBI must present) and the only connection to data/db/mock-core-banking.db
// (read-only in Step 4A). Listens on 127.0.0.1 only.
//
// Port: VAULTPAY_MOCK_BANK_PORT (default 4100; 0 = any free port, used by tests).

import { defaultDataDir } from '../../lib/server/db/definitions.js';
import { openMockCoreBankingDb } from '../../lib/server/db/index.js';
import { loadProcessEnv, requireNode22 } from '../../lib/services/process-env.js';
import { MOCK_CORE_BANKING_HOST, mockCoreBankingPort } from '../../lib/services/ports.js';

import { createMockCoreBankingServer } from './app.js';

requireNode22();

const dataDir = defaultDataDir();
let config;
let db;
try {
  config = loadProcessEnv('mock-core-banking', { dataDir, required: ['MOCK_CORE_BANKING_API_KEY'] });
  db = openMockCoreBankingDb({ dataDir, readonly: true });
} catch (err) {
  console.error(`mock Core Banking cannot start: ${err.code ?? 'ERROR'} – ${err.message}`);
  process.exit(1);
}

const server = createMockCoreBankingServer({
  tls: config.tls,
  apiKey: config.values.MOCK_CORE_BANKING_API_KEY,
  db,
  log: (msg) => console.log(`[mock-core-banking] ${msg}`),
});

server.listen(mockCoreBankingPort(), MOCK_CORE_BANKING_HOST, () => {
  const { address, port } = server.address();
  console.log(`[mock-core-banking] listening on https://${address}:${port} (mTLS, clients: vaultpay-cbi)`);
});

const shutdown = () => server.close(() => {
  db.close();
  process.exit(0);
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

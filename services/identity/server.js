// npm run identity – the Identity service as its own Node.js process (Step 4B).
//
// Owns: data/secrets/identity.env – the ONLY copy of the service-token signing key – plus
// its server certificate, and a read-only connection to the identity database (to validate
// customer sessions and wallet mappings). Listens on 127.0.0.1 only.
// Port: VAULTPAY_IDENTITY_PORT (default 4200; 0 = any free port, used by tests).

import { defaultDataDir } from '../../lib/server/db/definitions.js';
import { openIdentityDb } from '../../lib/server/db/index.js';
import { servicePort, SERVICE_HOST } from '../../lib/services/ports.js';
import { loadProcessEnv, requireNode22 } from '../../lib/services/process-env.js';
import { privateKeyFrom, publicKeyFrom } from '../../lib/services/service-token.js';

import { createIdentityServer } from './app.js';

requireNode22();

const dataDir = defaultDataDir();
let config;
let db;
let signingKey;
let riskPublicKey;
try {
  config = loadProcessEnv('identity', { dataDir, required: ['SERVICE_TOKEN_SIGNING_KEY', 'SERVICE_TOKEN_KEY_ID', 'RISK_DECISION_PUBLIC_KEY', 'RISK_DECISION_KEY_ID'] });
  signingKey = privateKeyFrom(config.values.SERVICE_TOKEN_SIGNING_KEY);
  riskPublicKey = publicKeyFrom(config.values.RISK_DECISION_PUBLIC_KEY);
  db = openIdentityDb({ dataDir, readonly: true });
} catch (err) {
  console.error(`Identity service cannot start: ${err.code ?? 'ERROR'} – ${err.message}`);
  process.exit(1);
}

const server = createIdentityServer({
  tls: config.tls,
  signingKey,
  keyId: config.values.SERVICE_TOKEN_KEY_ID,
  identityDb: db,
  riskPublicKey,
  riskKeyId: config.values.RISK_DECISION_KEY_ID,
  log: (msg) => console.log(`[identity] ${msg}`),
});

server.listen(servicePort('identity'), SERVICE_HOST, () => {
  const { address, port } = server.address();
  console.log(`[identity] listening on https://${address}:${port} (mTLS, clients: vaultpay-web → balance tokens, vaultpay-settlement → settlement tokens, vaultpay-recon → reconciliation tokens)`);
});

const shutdown = () => server.close(() => {
  db.close();
  process.exit(0);
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

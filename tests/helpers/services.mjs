// Starts the mock bank, Identity and CBI services in-process (real HTTPS + mTLS, real
// certificates and keys of a temporary installation) next to an authHarness.

import fs from 'node:fs';
import https from 'node:https';

import { loadCoreBankingClient } from '../../lib/cbi/core-banking-client.js';
import { openIdentityDb, openMockCoreBankingDb } from '../../lib/server/db/index.js';
import { loadProcessEnv } from '../../lib/services/process-env.js';
import { createReplayCache, privateKeyFrom, publicKeyFrom } from '../../lib/services/service-token.js';
import { createCbiServer } from '../../services/cbi/app.js';
import { createIdentityServer } from '../../services/identity/app.js';
import { createMockCoreBankingServer } from '../../services/mock-core-banking/app.js';
import { authHarness } from './auth-flow.mjs';
import { onCleanup } from './db.mjs';
import { pkiFile } from './setup.mjs';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

export async function servicesHarness(t, { bankTimeoutMs = 1500 } = {}) {
  const h = await authHarness(t);
  const { dataDir } = h;

  const bankEnv = loadProcessEnv('mock-core-banking', { dataDir });
  // The bank's own (writable, Step 7 postings) connection; `bankDelay.ms` delays posting answers.
  const bankDb = openMockCoreBankingDb({ dataDir });
  const bankDelay = { ms: 0 };
  const bank = createMockCoreBankingServer({ tls: bankEnv.tls, apiKey: bankEnv.values.MOCK_CORE_BANKING_API_KEY, db: bankDb, postResponseDelayMs: () => bankDelay.ms });
  const bankPort = await listen(bank);

  const identityEnv = loadProcessEnv('identity', { dataDir });
  const identityDb = openIdentityDb({ dataDir, readonly: true });
  const signingKey = privateKeyFrom(identityEnv.values.SERVICE_TOKEN_SIGNING_KEY);
  const keyId = identityEnv.values.SERVICE_TOKEN_KEY_ID;
  const identity = createIdentityServer({
    tls: identityEnv.tls, signingKey, keyId, identityDb,
    riskPublicKey: publicKeyFrom(identityEnv.values.RISK_DECISION_PUBLIC_KEY), riskKeyId: identityEnv.values.RISK_DECISION_KEY_ID,
  });
  const identityPort = await listen(identity);

  const cbiEnv = loadProcessEnv('cbi', { dataDir });
  const replayCache = createReplayCache();
  const cbi = createCbiServer({
    tls: cbiEnv.tls,
    tokenPublicKey: publicKeyFrom(cbiEnv.values.SERVICE_TOKEN_PUBLIC_KEY),
    keyId,
    bank: loadCoreBankingClient({ dataDir, port: bankPort, timeoutMs: bankTimeoutMs }),
    replayCache,
  });
  const cbiPort = await listen(cbi);

  const close = (server) => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  onCleanup(t, () => { bankDb.close(); identityDb.close(); });
  for (const s of [bank, identity, cbi]) onCleanup(t, () => (s.listening ? close(s) : undefined));

  const webCredentials = loadProcessEnv('web', { dataDir }).tls;
  const certOf = (name) => ({ cert: fs.readFileSync(pkiFile(dataDir, `${name}.crt`)), key: fs.readFileSync(pkiFile(dataDir, `${name}.key`)), ca: fs.readFileSync(pkiFile(dataDir, 'ca.crt')) });
  /** The Better Auth session token of a cookie-jar browser. */
  const sessionTokenOf = (browser) => {
    const cookie = browser.headers().get('cookie').split('; ').find((c) => c.startsWith('better-auth.session_token='));
    const value = decodeURIComponent(cookie.split('=').slice(1).join('='));
    return value.slice(0, value.lastIndexOf('.'));
  };
  /** Raw HTTPS call with explicit credentials. */
  const call = (port, { path, method = 'GET', creds = webCredentials, headers = {}, body }) => new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({ host: '127.0.0.1', port, path, method, servername: 'localhost', ...creds, agent: false, timeout: 3000,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code ?? err.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(payload);
  });

  return {
    ...h, bank, identity, cbi, bankPort, identityPort, cbiPort, signingKey, keyId, replayCache, bankDb, bankDelay,
    webCredentials, certOf, sessionTokenOf, call, close,
    balanceDeps: (browser) => ({ sessionToken: sessionTokenOf(browser), credentials: webCredentials, identityPort, cbiPort, timeoutMs: 2000 }),
  };
}

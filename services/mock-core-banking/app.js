// Mock Core Banking HTTPS service (Step 4A) – stands in for the partner Core Banking
// System that VaultPay does not control. Only Core Banking Integration (CBI) may call it.
//
// Every request must pass, in this order:
//   1. mutual TLS: a client certificate signed by this installation's development CA
//      (rejectUnauthorized: true – unauthenticated clients never reach HTTP)
//   2. caller identity: the certificate subject must be CN=vaultpay-cbi (Settlement and
//      Reconciliation have certificates from the same CA but must not reach the bank)
//   3. the partner credential CBI holds (Authorization: Bearer <MOCK_CORE_BANKING_API_KEY>)
//   4. a strictly validated request
// Errors are generic JSON ({"error": "<code>"}): no stack traces, paths, SQL or input echo.
//
// Read-only for now: GET /v1/accounts/{accountRef}/balance. Postings arrive in Step 5.

import crypto from 'node:crypto';
import https from 'node:https';

export const ALLOWED_CLIENTS = Object.freeze(['vaultpay-cbi']);
export const ACCOUNT_REF_PATTERN = /^MCB-[0-9]{4,10}$/;
const BALANCE_PATH = /^\/v1\/accounts\/([^/]*)\/balance$/;
const MAX_URL_LENGTH = 256;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function send(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(text);
}

/**
 * Creates the server (not listening). `db` is a read-only connection to the mock Core
 * Banking database; `apiKey` is the credential CBI must present.
 */
export function createMockCoreBankingServer({ tls, apiKey, db, allowedClients = ALLOWED_CLIENTS, log = () => {} }) {
  if (!apiKey || apiKey.length < 32) throw new Error('mock Core Banking: API key missing or too short');
  const balanceOf = db.prepare('SELECT account_ref, currency, status, balance_cents, updated_at FROM account WHERE account_ref = ?');

  const server = https.createServer({
    key: tls.key,
    cert: tls.cert,
    ca: tls.ca,
    requestCert: true,
    rejectUnauthorized: true, // never disabled: clients without a CA-signed certificate fail the handshake
    minVersion: 'TLSv1.2',
  }, (req, res) => {
    try {
      // (1) is enforced by the TLS layer; double-check rather than assume.
      if (!req.socket.authorized) return send(res, 401, { error: 'unauthorized' });
      const peer = req.socket.getPeerCertificate();
      if (!allowedClients.includes(peer?.subject?.CN)) {
        log(`refused client CN=${peer?.subject?.CN ?? '?'}`);
        return send(res, 403, { error: 'forbidden' });
      }
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), apiKey)) return send(res, 401, { error: 'unauthorized' });

      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      const url = req.url ?? '';
      if (url.length > MAX_URL_LENGTH || url.includes('?') || url.includes('#')) return send(res, 400, { error: 'invalid_request' });
      const match = BALANCE_PATH.exec(url);
      if (!match) return send(res, 404, { error: 'not_found' });
      const accountRef = match[1];
      if (!ACCOUNT_REF_PATTERN.test(accountRef)) return send(res, 400, { error: 'invalid_account' });

      const row = balanceOf.get(accountRef);
      if (!row) return send(res, 404, { error: 'not_found' });
      return send(res, 200, {
        accountRef: row.account_ref,
        currency: row.currency,
        balanceCents: row.balance_cents,
        status: row.status,
        asOf: new Date(row.updated_at).toISOString(),
      });
    } catch (err) {
      log(`internal error: ${err.code ?? err.name}`);
      return send(res, 500, { error: 'internal_error' });
    }
  });

  // Slow or idle clients cannot hold connections open.
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 50;
  return server;
}

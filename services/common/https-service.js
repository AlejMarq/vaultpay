// Shared plumbing for VaultPay's internal HTTPS services (Identity, CBI): mutual TLS that
// is never relaxed, an exact allowlist of caller certificates, small JSON request bodies
// and generic JSON errors. Each service supplies only its routes.

import https from 'node:https';

const MAX_BODY_BYTES = 4096;

export function sendJson(res, status, body, extraHeaders = {}) {
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

/** Reads a small JSON body; resolves undefined if it is not valid JSON or too large. */
export function readJsonBody(req) {
  return new Promise((resolve) => {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return resolve(undefined);
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(undefined);
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

/**
 * Creates an mTLS HTTPS server. `handle(req, res, peer)` runs only for an authorized
 * client whose certificate CN is in `allowedClients`; everything else gets a generic error.
 */
export function createServiceServer({ tls, allowedClients, handle, log = () => {} }) {
  const server = https.createServer({
    key: tls.key, cert: tls.cert, ca: tls.ca,
    requestCert: true,
    rejectUnauthorized: true, // never disabled
    minVersion: 'TLSv1.2',
  }, async (req, res) => {
    try {
      if (!req.socket.authorized) return sendJson(res, 401, { error: 'unauthorized' });
      const peer = req.socket.getPeerCertificate();
      if (!allowedClients.includes(peer?.subject?.CN)) {
        log(`refused client CN=${peer?.subject?.CN ?? '?'}`);
        return sendJson(res, 403, { error: 'forbidden' });
      }
      return await handle(req, res, peer);
    } catch (err) {
      log(`internal error: ${err.code ?? err.name}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.destroy();
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 50;
  return server;
}

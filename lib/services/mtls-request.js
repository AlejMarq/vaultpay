// One mutually authenticated HTTPS request between VaultPay processes (Step 4B).
//
//   - presents the caller's client certificate; verifies the server against the dev CA,
//     its localhost SAN, AND an exact expected CN (a valid certificate of another
//     service is refused)
//   - a hard deadline covering connect, TLS, request and response
//   - a response size limit; JSON only
// Rejects with an Error whose `code` is 'unavailable' (network, TLS, timeout),
// 'bad_server' (identity), or 'bad_response' (size, content type, JSON). Never includes
// a response body, header value or credential in the message.

import https from 'node:https';
import tls from 'node:tls';

export const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BYTES = 16 * 1024;

const failure = (code, message) => Object.assign(new Error(message), { code });

export function mtlsRequest({
  host = '127.0.0.1', port, method = 'GET', path, credentials, expectedServer,
  headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES,
}) {
  if (!expectedServer) throw new Error('mtlsRequest: expectedServer is required');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const checkServerIdentity = (hostname, cert) => tls.checkServerIdentity(hostname, cert)
    ?? (cert?.subject?.CN === expectedServer ? undefined : new Error('unexpected server identity'));

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const req = https.request({
      host, port, path, method,
      servername: 'localhost',
      cert: credentials.cert, key: credentials.key, ca: credentials.ca,
      minVersion: 'TLSv1.2',
      checkServerIdentity,
      agent: false, // a fresh, fully verified connection per call
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          done(reject, failure('bad_response', `${expectedServer}: response too large`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const type = res.headers['content-type'] ?? '';
        let json;
        if (type.startsWith('application/json')) {
          try {
            json = JSON.parse(text);
          } catch {
            done(reject, failure('bad_response', `${expectedServer}: invalid JSON`));
            return;
          }
        }
        done(resolve, { status: res.statusCode, type, json });
      });
      res.on('error', () => done(reject, failure('unavailable', `${expectedServer}: response interrupted`)));
    });
    const deadline = setTimeout(() => {
      req.destroy();
      done(reject, failure('unavailable', `${expectedServer} did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    req.on('error', (err) => {
      const identity = /server identity|Hostname\/IP does not match/i.test(err.message);
      done(reject, identity
        ? failure('bad_server', `${expectedServer}: server identity could not be verified`)
        : failure('unavailable', `${expectedServer} unreachable (${err.code ?? 'error'})`));
    });
    req.end(payload);
  });
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { CoreBankingError, createCoreBankingClient, loadCoreBankingClient } from '../../lib/cbi/core-banking-client.js';
import { openMockCoreBankingDb } from '../../lib/server/db/index.js';
import { loadProcessEnv } from '../../lib/services/process-env.js';
import { createMockCoreBankingServer } from '../../services/mock-core-banking/app.js';
import { onCleanup } from '../helpers/db.mjs';
import { freshInstall, pkiFile } from '../helpers/setup.mjs';

// Every response body and header seen in this file is checked for secret material at the end.
const seen = [];

async function bank(t, { dataDir } = {}) {
  const install = dataDir ? { dataDir } : await freshInstall(t);
  const bankEnv = loadProcessEnv('mock-core-banking', { dataDir: install.dataDir });
  const cbiEnv = loadProcessEnv('cbi', { dataDir: install.dataDir });
  const db = openMockCoreBankingDb({ dataDir: install.dataDir, readonly: true });
  const server = createMockCoreBankingServer({ tls: bankEnv.tls, apiKey: bankEnv.values.MOCK_CORE_BANKING_API_KEY, db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  onCleanup(t, () => { db.close(); });
  onCleanup(t, () => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const client = loadCoreBankingClient({ dataDir: install.dataDir, port });
  return { ...install, server, port, client, cbiEnv, bankEnv, apiKey: cbiEnv.values.MOCK_CORE_BANKING_API_KEY };
}

/** A raw HTTPS request with explicit credentials, for probing the server directly. */
function raw(port, { path: p = '/v1/accounts/MCB-1001/balance', method = 'GET', cert, key, ca, apiKey, timeout = 3000 }) {
  return new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: p, method, servername: 'localhost', cert, key, ca, agent: false, timeout,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        seen.push(JSON.stringify(res.headers), body);
        resolve({ ok: true, status: res.statusCode, headers: res.headers, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() });
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code ?? err.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const creds = (env) => ({ cert: env.tls.cert, key: env.tls.key, ca: env.tls.ca });
const pki = (dataDir, name) => ({ cert: fs.readFileSync(pkiFile(dataDir, `${name}.crt`)), key: fs.readFileSync(pkiFile(dataDir, `${name}.key`)), ca: fs.readFileSync(pkiFile(dataDir, 'ca.crt')) });

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof CoreBankingError, `${err.name}: ${err.message}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

// ---------------------------------------------------------------------------
test('CBI retrieves a balance over mTLS', async (t) => {
  const b = await bank(t);
  assert.equal(b.server.address().address, '127.0.0.1', 'bound to localhost only');
  const balance = await b.client.getBalance('MCB-1001');
  assert.deepEqual({ ...balance, asOf: typeof balance.asOf }, { accountRef: 'MCB-1001', currency: 'USD', balanceCents: 50_000, status: 'active', asOf: 'string' });
  assert.ok(!Number.isNaN(Date.parse(balance.asOf)));
  assert.equal((await b.client.getBalance('MCB-2001')).balanceCents, 0);

  const r = await raw(b.port, { ...creds(b.cbiEnv), apiKey: b.apiKey });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('no client certificate: refused in the TLS handshake', async (t) => {
  const b = await bank(t);
  const r = await raw(b.port, { ca: b.cbiEnv.tls.ca, apiKey: b.apiKey });
  assert.equal(r.ok, false, `got HTTP ${r.status}`);
});

test('a client certificate from another installation\'s CA is refused in the handshake', async (t) => {
  const b = await bank(t);
  const other = await freshInstall(t);
  const rogue = pki(other.dataDir, 'cbi');
  const r = await raw(b.port, { cert: rogue.cert, key: rogue.key, ca: b.cbiEnv.tls.ca, apiKey: b.apiKey });
  assert.equal(r.ok, false, `got HTTP ${r.status}`);
});

test('a certificate without client usage (the bank\'s own server certificate) is refused', async (t) => {
  const b = await bank(t);
  const r = await raw(b.port, { ...creds(b.bankEnv), apiKey: b.apiKey });
  assert.equal(r.ok, false, `got HTTP ${r.status}`);
});

test('other VaultPay services (same CA) are refused: only CBI may reach Core Banking', async (t) => {
  const b = await bank(t);
  for (const name of ['settlement', 'recon']) {
    const r = await raw(b.port, { ...pki(b.dataDir, name), apiKey: b.apiKey });
    assert.equal(r.status, 403, name);
    assert.deepEqual(r.json, { error: 'forbidden' });
  }
});

test('a missing or wrong Core Banking credential is refused', async (t) => {
  const b = await bank(t);
  for (const apiKey of [undefined, 'wrong-key', `${b.apiKey}x`]) {
    const r = await raw(b.port, { ...creds(b.cbiEnv), apiKey });
    assert.equal(r.status, 401, String(apiKey));
    assert.deepEqual(r.json, { error: 'unauthorized' });
  }
  const wrongKeyClient = createCoreBankingClient({ port: b.port, tls: b.cbiEnv.tls, apiKey: 'a'.repeat(43) });
  await rejectsWith(wrongKeyClient.getBalance('MCB-1001'), 'rejected');
});

test('invalid account identifiers are refused (client side and server side)', async (t) => {
  const b = await bank(t);
  for (const bad of ['', 'mcb-1001', 'MCB-1', 'MCB-1001x', '../MCB-1001', 'MCB-1001/../x', `MCB-${'1'.repeat(20)}`, 'MCB-1001%2F', undefined, 42]) {
    await rejectsWith(b.client.getBalance(bad), 'invalid_account');
  }
  const authed = { ...creds(b.cbiEnv), apiKey: b.apiKey };
  for (const p of ['/v1/accounts/mcb-1001/balance', '/v1/accounts/MCB-1/balance', '/v1/accounts/MCB-1001%2F/balance', '/v1/accounts/../balance', '/v1/accounts//balance']) {
    const r = await raw(b.port, { ...authed, path: p });
    assert.equal(r.status, 400, p);
    assert.deepEqual(r.json, { error: 'invalid_account' }, p);
  }
  assert.deepEqual((await raw(b.port, { ...authed, path: '/v1/accounts/MCB-1001/balance?x=1' })).json, { error: 'invalid_request' });
  assert.deepEqual((await raw(b.port, { ...authed, path: `/v1/accounts/${'A'.repeat(300)}/balance` })).json, { error: 'invalid_request' });
  assert.deepEqual((await raw(b.port, { ...authed, path: '/v1/admin' })).json, { error: 'not_found' });
  const post = await raw(b.port, { ...authed, method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET');
});

test('unknown accounts get a generic "not found"', async (t) => {
  const b = await bank(t);
  await rejectsWith(b.client.getBalance('MCB-9999'), 'not_found');
  const r = await raw(b.port, { ...creds(b.cbiEnv), apiKey: b.apiKey, path: '/v1/accounts/MCB-9999/balance' });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: 'not_found' });
});

test('unauthenticated callers learn nothing about accounts', async (t) => {
  const b = await bank(t);
  const unknown = await raw(b.port, { ...pki(b.dataDir, 'settlement'), apiKey: b.apiKey, path: '/v1/accounts/MCB-9999/balance' });
  const known = await raw(b.port, { ...pki(b.dataDir, 'settlement'), apiKey: b.apiKey, path: '/v1/accounts/MCB-1001/balance' });
  assert.deepEqual([unknown.status, known.status], [403, 403], 'identity is checked before the account');
});

// ---------------------------------------------------------------------------
// Connection failures and timeouts
// ---------------------------------------------------------------------------
test('connection refused → unavailable', async (t) => {
  const b = await bank(t);
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const client = createCoreBankingClient({ port, tls: b.cbiEnv.tls, apiKey: b.apiKey, timeoutMs: 1000 });
  await rejectsWith(client.getBalance('MCB-1001'), 'unavailable');
});

test('a server that never completes TLS, or never answers, times out → unavailable', async (t) => {
  const b = await bank(t);
  // TCP accepted, no TLS handshake ever.
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  onCleanup(t, () => new Promise((r) => { silent.close(r); }));
  const started = Date.now();
  await rejectsWith(createCoreBankingClient({ port: silent.address().port, tls: b.cbiEnv.tls, apiKey: b.apiKey, timeoutMs: 500 }).getBalance('MCB-1001'), 'unavailable');
  assert.ok(Date.now() - started < 2000, 'deadline enforced');

  // TLS completes, HTTP never answers.
  const hung = https.createServer({ ...creds(b.bankEnv), requestCert: true, rejectUnauthorized: true }, () => {});
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  onCleanup(t, () => new Promise((r) => { hung.closeAllConnections(); hung.close(r); }));
  await rejectsWith(createCoreBankingClient({ port: hung.address().port, tls: b.cbiEnv.tls, apiKey: b.apiKey, timeoutMs: 500 }).getBalance('MCB-1001'), 'unavailable');
});

// ---------------------------------------------------------------------------
// The bank is untrusted too (threat 85)
// ---------------------------------------------------------------------------
async function fakeBank(t, b, handler, { identity = 'mock-core-banking' } = {}) {
  const cert = pki(b.dataDir, identity);
  const server = https.createServer({ ...cert, requestCert: true, rejectUnauthorized: true }, handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  onCleanup(t, () => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return createCoreBankingClient({ port: server.address().port, tls: b.cbiEnv.tls, apiKey: b.apiKey, timeoutMs: 1000 });
}
const reply = (status, body, type = 'application/json') => (req, res) => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

test('a VaultPay certificate that is not the bank\'s is refused as the server (spoofed bank)', async (t) => {
  const b = await bank(t);
  const client = await fakeBank(t, b, reply(200, { accountRef: 'MCB-1001', currency: 'USD', balanceCents: 1, status: 'active', asOf: new Date().toISOString() }), { identity: 'cbi' });
  await rejectsWith(client.getBalance('MCB-1001'), 'bad_response');
});

test('a server from another installation\'s CA is refused', async (t) => {
  const b = await bank(t);
  const other = await freshInstall(t);
  const server = https.createServer({ ...pki(other.dataDir, 'mock-core-banking'), requestCert: false }, reply(200, {}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  onCleanup(t, () => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  await rejectsWith(createCoreBankingClient({ port: server.address().port, tls: b.cbiEnv.tls, apiKey: b.apiKey, timeoutMs: 1000 }).getBalance('MCB-1001'), 'unavailable');
});

test('malformed, oversized or mismatched bank responses are refused', async (t) => {
  const b = await bank(t);
  const now = new Date().toISOString();
  const good = { accountRef: 'MCB-1001', currency: 'USD', balanceCents: 100, status: 'active', asOf: now };
  for (const [label, handler] of [
    ['not JSON', reply(200, 'not json')],
    ['wrong content type', reply(200, JSON.stringify(good), 'text/html')],
    ['extra field', reply(200, { ...good, debug: 'x' })],
    ['negative balance', reply(200, { ...good, balanceCents: -1 })],
    ['fractional cents', reply(200, { ...good, balanceCents: 1.5 })],
    ['other currency', reply(200, { ...good, currency: 'EUR' })],
    ['other account', reply(200, { ...good, accountRef: 'MCB-1002' })],
    ['bad timestamp', reply(200, { ...good, asOf: 'yesterday' })],
    ['too large', reply(200, JSON.stringify({ ...good, pad: 'x'.repeat(20_000) }))],
    ['unexpected status', reply(302, good)],
  ]) {
    const client = await fakeBank(t, b, handler);
    await rejectsWith(client.getBalance('MCB-1001'), 'bad_response').catch((err) => assert.fail(`${label}: ${err.message}`));
  }
  await rejectsWith((await fakeBank(t, b, reply(503, { error: 'x' }))).getBalance('MCB-1001'), 'unavailable');
});

// ---------------------------------------------------------------------------
// Secrets and trust boundaries
// ---------------------------------------------------------------------------
test('no secret material in any response or client error', async (t) => {
  const b = await bank(t);
  const errors = [];
  for (const ref of ['MCB-9999', 'bad']) await b.client.getBalance(ref).catch((e) => errors.push(e.message));
  await createCoreBankingClient({ port: b.port, tls: b.cbiEnv.tls, apiKey: 'z'.repeat(43) }).getBalance('MCB-1001').catch((e) => errors.push(e.message));
  const everything = [...seen, ...errors].join('\n');
  assert.ok(seen.length > 20, `checked ${seen.length} response parts`);
  const forbidden = [
    b.apiKey, 'z'.repeat(43), 'PRIVATE KEY', 'CERTIFICATE',
    b.cbiEnv.tls.key.toString().split('\n')[1], b.bankEnv.tls.key.toString().split('\n')[1],
    'secrets', path.join('data', 'db'), 'SQLITE', 'stack', '    at ',
  ];
  for (const f of forbidden) assert.ok(!everything.includes(f), `response/error contains ${f.slice(0, 20)}…`);
});

test('the Next.js app never touches Core Banking, CBI credentials or the mock bank database', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.(js|mjs)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        // Next.js may use the shared mTLS helper (lib/services/mtls-request.js) for its own
        // calls to Identity and CBI, but never the bank client, the bank or its credentials.
        if (/lib\/cbi|services\/mock-core-banking|cbi\.env|mock-core-banking\.env|openMockCoreBankingDb|['"]mock-core-banking['"]/.test(src)) offenders.push(p);
      }
    }
  };
  scan('app');
  scan(path.join('lib', 'server'));
  // lib/server/db defines the mock bank database (shared definitions); nothing else may use it.
  assert.deepEqual(offenders.filter((p) => !p.includes(path.join('lib', 'server', 'db'))), []);
  for (const f of fs.readdirSync(path.join('lib', 'server', 'db')).filter((n) => n.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join('lib', 'server', 'db', f), 'utf8'), /lib\/cbi|services\//, f);
  }
});

test('TLS verification is never disabled anywhere in the code', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.(js|mjs)$/.test(e.name) && /rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  for (const d of ['app', 'lib', 'services', 'scripts']) scan(d);
  assert.deepEqual(offenders, []);
});

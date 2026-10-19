import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { test } from 'node:test';

import { CERTIFICATES, LEAF_DAYS, verifyPki } from '../../scripts/setup/pki.mjs';
import { freshInstall, pkiFile } from '../helpers/setup.mjs';

const DAY = 24 * 60 * 60 * 1000;
const read = (dataDir, f) => fs.readFileSync(pkiFile(dataDir, f));

test('every service certificate chains to the dev CA with exactly the intended usage', async (t) => {
  const { dataDir } = await freshInstall(t);
  const ca = new crypto.X509Certificate(read(dataDir, 'ca.crt'));
  assert.equal(ca.ca, true);
  for (const c of CERTIFICATES) {
    const x = new crypto.X509Certificate(read(dataDir, `${c.name}.crt`));
    assert.equal(x.subject, `CN=${c.cn}`);
    assert.ok(x.checkIssued(ca) && x.verify(ca.publicKey), `${c.name} signed by CA`);
    assert.equal(x.ca, false);
    assert.equal(x.keyUsage.includes('1.3.6.1.5.5.7.3.1'), c.serverAuth, `${c.name} serverAuth`);
    assert.equal(x.keyUsage.includes('1.3.6.1.5.5.7.3.2'), c.clientAuth, `${c.name} clientAuth`);
    const days = (new Date(x.validTo) - new Date(x.validFrom)) / DAY;
    assert.ok(Math.abs(days - LEAF_DAYS) <= 1, `${c.name} lifetime ${days} days`);
  }
  const caDays = (new Date(ca.validTo) - new Date(ca.validFrom)) / DAY;
  assert.ok(Math.abs(caDays - 730) <= 1, `CA lifetime ${caDays} days`);
});

test('expiry: warning inside 30 days, failure once expired or not yet valid', async (t) => {
  const { dataDir } = await freshInstall(t);
  const dir = path.join(dataDir, 'pki');
  assert.deepEqual(verifyPki(dir).problems, []);

  const soon = verifyPki(dir, { now: Date.now() + (LEAF_DAYS - 10) * DAY });
  assert.deepEqual(soon.problems, []);
  assert.equal(soon.warnings.length, CERTIFICATES.length);
  assert.match(soon.warnings[0], /expires in \d+ day\(s\).*--renew-certs/);

  assert.match(verifyPki(dir, { now: Date.now() + (LEAF_DAYS + 1) * DAY }).problems.join(), /expired/);
  assert.match(verifyPki(dir, { now: Date.now() - DAY }).problems.join(), /not valid until/);
});

test('swapped, foreign or mismatched certificate files are detected', async (t) => {
  const { dataDir } = await freshInstall(t);
  const other = await freshInstall(t);
  const dir = path.join(dataDir, 'pki');

  fs.copyFileSync(pkiFile(other.dataDir, 'cbi.crt'), pkiFile(dataDir, 'cbi.crt'));
  const foreign = verifyPki(dir).problems.join('\n');
  assert.match(foreign, /cbi\.crt: not signed by the VaultPay development CA/);
  assert.match(foreign, /cbi\.key: does not match cbi\.crt/);

  fs.copyFileSync(pkiFile(dataDir, 'settlement.crt'), pkiFile(dataDir, 'recon.crt'));
  assert.match(verifyPki(dir).problems.join('\n'), /recon\.crt: subject CN=vaultpay-settlement, expected CN=vaultpay-recon/);

  fs.writeFileSync(pkiFile(dataDir, 'extra.pem'), 'x');
  assert.match(verifyPki(dir).problems.join('\n'), /unexpected files: extra\.pem/);
});

// ---------------------------------------------------------------------------
// Real mutual-TLS handshakes with the generated files (the Core Banking links)
// ---------------------------------------------------------------------------
async function withMtlsServer(t, dataDir, serverName, fn) {
  const server = https.createServer({
    key: read(dataDir, `${serverName}.key`),
    cert: read(dataDir, `${serverName}.crt`),
    ca: read(dataDir, 'ca.crt'),
    requestCert: true,
    rejectUnauthorized: true,
  }, (req, res) => res.end(req.socket.getPeerCertificate().subject.CN));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const request = (opts) => new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port: server.address().port, servername: 'localhost', agent: false, timeout: 3000, ...opts }, (res) => {
      const serverCn = res.socket.getPeerCertificate()?.subject?.CN;
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: true, body, serverCn }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code ?? err.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
  await fn(request);
}

const client = (dataDir, name, caDir = dataDir) => ({ ca: read(caDir, 'ca.crt'), key: read(dataDir, `${name}.key`), cert: read(dataDir, `${name}.crt`) });

test('mTLS: Settlement and Reconciliation can reach CBI; CBI identifies them', async (t) => {
  const { dataDir } = await freshInstall(t);
  await withMtlsServer(t, dataDir, 'cbi', async (request) => {
    for (const [name, cn] of [['settlement', 'vaultpay-settlement'], ['recon', 'vaultpay-recon']]) {
      const r = await request(client(dataDir, name));
      assert.ok(r.ok, `${name}: ${r.error}`);
      assert.equal(r.body, cn);
      assert.equal(r.serverCn, 'vaultpay-cbi');
    }
  });
});

test('mTLS: CBI can reach mock Core Banking as a client', async (t) => {
  const { dataDir } = await freshInstall(t);
  await withMtlsServer(t, dataDir, 'mock-core-banking', async (request) => {
    const r = await request(client(dataDir, 'cbi'));
    assert.ok(r.ok, r.error);
    assert.equal(r.body, 'vaultpay-cbi');
    assert.equal(r.serverCn, 'vaultpay-mock-core-banking');
  });
});

test('mTLS: CBI refuses no certificate, a server-only certificate, and another installation\'s CA', async (t) => {
  const { dataDir } = await freshInstall(t);
  const other = await freshInstall(t);
  await withMtlsServer(t, dataDir, 'cbi', async (request) => {
    assert.equal((await request({ ca: read(dataDir, 'ca.crt') })).ok, false, 'no client certificate');
    assert.equal((await request(client(dataDir, 'mock-core-banking'))).ok, false, 'certificate without clientAuth usage');
    assert.equal((await request(client(other.dataDir, 'settlement', dataDir))).ok, false, 'client from a different CA');
  });
});

test('mTLS: a client refuses a CBI endpoint it cannot verify (spoofed adapter, threat 280)', async (t) => {
  const { dataDir } = await freshInstall(t);
  const other = await freshInstall(t);
  // The "spoofed" server is a real CBI certificate – but from another installation's CA.
  await withMtlsServer(t, other.dataDir, 'cbi', async (request) => {
    const r = await request(client(dataDir, 'settlement'));
    assert.equal(r.ok, false);
  });
});

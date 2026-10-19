// npm run test:services – starts mock Core Banking, Identity and CBI as separate processes
// (exactly like `npm run services`) on a temporary installation and checks them from the
// outside: localhost-only binding, refusal without setup, mTLS caller allowlists, generic
// errors, and no secret material in logs or responses. The full customer flow through the
// app is covered by `npm run test:http`. Never touches this computer's data/.

import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { loadProcessEnv } from '../lib/services/process-env.js';

import { startAllServices, startService } from './lib/spawn-service.mjs';
import { runSetup } from './setup/run.mjs';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? ` -> ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const tryConnect = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 1500 });
  s.on('connect', () => { s.destroy(); resolve('connected'); });
  s.on('timeout', () => { s.destroy(); resolve('timeout'); });
  s.on('error', (e) => resolve(e.code));
});
const call = (port, { path: p, method = 'GET', creds, headers = {}, body }) => new Promise((resolve) => {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const req = https.request({ host: '127.0.0.1', port, path: p, method, servername: 'localhost', ...creds, agent: false, timeout: 3000,
    headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers } }, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', (e) => resolve({ status: 0, error: e.code ?? e.message, text: '' }));
  req.end(payload);
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpay-services-'));
let running;
const texts = [];
try {
  console.log('\nStart-up');
  for (const name of ['identity', 'cbi']) {
    const s = startService(name, { env: { VAULTPAY_DATA_DIR: path.join(dataDir, 'not-set-up'), VAULTPAY_IDENTITY_PORT: '0', VAULTPAY_CBI_PORT: '0' } });
    const code = await s.exited;
    check(`${name} refuses to start without an installation`, code === 1 && /npm run setup/.test(s.output()), `${code} ${s.output().trim()}`);
  }
  await runSetup({ dataDir });
  running = await startAllServices({ dataDir });
  for (const [name, at] of Object.entries(running.addresses)) check(`${name} runs as its own process on 127.0.0.1`, at.address === '127.0.0.1', at.address);

  console.log('\nLocalhost only');
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  if (lan.length === 0) console.log('  SKIP  no LAN IPv4 address');
  for (const a of lan) for (const [name, port] of Object.entries(running.ports)) check(`${name} not reachable on ${a}:${port}`, (await tryConnect(a, port)) !== 'connected');

  console.log('\nCaller allowlists (mTLS)');
  const creds = (name) => {
    const dir = path.join(dataDir, 'pki');
    return { cert: fs.readFileSync(path.join(dir, `${name}.crt`)), key: fs.readFileSync(path.join(dir, `${name}.key`)), ca: fs.readFileSync(path.join(dir, 'ca.crt')) };
  };
  const web = loadProcessEnv('web', { dataDir }).tls;
  const tokenPath = '/v1/service-tokens/customer-balance';
  const noCert = await call(running.ports.identity, { path: tokenPath, method: 'POST', creds: { ca: web.ca }, body: { sessionToken: 'x'.repeat(32) } });
  check('Identity: no client certificate → refused in the handshake', noCert.status === 0, String(noCert.status));
  for (const name of ['recon', 'settlement', 'cbi']) {
    const r = await call(running.ports.identity, { path: tokenPath, method: 'POST', creds: creds(name), body: { sessionToken: 'x'.repeat(32) } });
    texts.push(r.text);
    check(`Identity refuses ${name}'s certificate (403)`, r.status === 403 && r.text === '{"error":"forbidden"}', `${r.status} ${r.text}`);
  }
  const unknownSession = await call(running.ports.identity, { path: tokenPath, method: 'POST', creds: web, body: { sessionToken: 'x'.repeat(32) } });
  texts.push(unknownSession.text);
  check('Identity: Next.js with an unknown session → generic 403', unknownSession.status === 403 && unknownSession.text === '{"error":"forbidden"}');
  const generic = await call(running.ports.identity, { path: '/v1/service-tokens/anything', method: 'POST', creds: web, body: { scope: 'x' } });
  texts.push(generic.text);
  check('Identity has no generic token endpoint (404)', generic.status === 404, String(generic.status));

  const cbiNoCert = await call(running.ports.cbi, { path: '/v1/balance', creds: { ca: web.ca } });
  check('CBI: no client certificate → refused in the handshake', cbiNoCert.status === 0, String(cbiNoCert.status));
  for (const name of ['recon', 'settlement']) {
    const r = await call(running.ports.cbi, { path: '/v1/balance', creds: creds(name) });
    texts.push(r.text);
    check(`CBI refuses ${name}'s certificate (403)`, r.status === 403, `${r.status} ${r.text}`);
  }
  const noToken = await call(running.ports.cbi, { path: '/v1/balance', creds: web });
  texts.push(noToken.text);
  check('CBI: Next.js without a token → 401', noToken.status === 401 && noToken.text === '{"error":"unauthorized"}', `${noToken.status} ${noToken.text}`);
  const accountParam = await call(running.ports.cbi, { path: '/v1/balance?account=MCB-1001', creds: web });
  check('CBI accepts no account from the request (400)', accountParam.status === 400, String(accountParam.status));
  const bankFromWeb = await call(running.ports.bank, { path: '/v1/accounts/MCB-1001/balance', creds: web });
  check('mock bank refuses Next.js\'s certificate (403) – only CBI may call it', bankFromWeb.status === 403, String(bankFromWeb.status));

  console.log('\nNo secret material');
  const env = (p) => fs.readFileSync(path.join(dataDir, 'secrets', `${p}.env`), 'utf8');
  const signing = env('identity').match(/^SERVICE_TOKEN_SIGNING_KEY=(.*)$/m)[1];
  const bankKey = env('cbi').match(/^MOCK_CORE_BANKING_API_KEY=(.*)$/m)[1];
  const logs = [running.bank, running.identity, running.cbi].map((s) => s.output()).join('\n');
  const all = `${logs}\n${texts.join('\n')}`;
  for (const [label, s] of [['signing key', signing], ['Core Banking credential', bankKey], ['PEM private key', 'PRIVATE KEY'], ['token', 'eyJ']]) {
    check(`no ${label} in service logs or responses`, !all.includes(s));
  }
  check('web.env holds no signing key; identity.env does', !env('web').includes('SERVICE_TOKEN_SIGNING_KEY') && env('identity').includes('SERVICE_TOKEN_SIGNING_KEY='));
} catch (e) {
  failures += 1;
  console.log(`  FAIL  ${e.stack ?? e.message}`);
} finally {
  if (running) await Promise.all([running.settlement.stop(), running.fraud.stop(), running.cbi.stop(), running.identity.stop(), running.bank.stop()]);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(failures === 0 ? '\nALL SERVICE CHECKS PASSED' : `\n${failures} SERVICE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

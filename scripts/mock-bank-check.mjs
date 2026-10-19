// npm run test:mock-bank – starts the mock Core Banking service as its own process
// (exactly like `npm run mock-bank`) on a temporary installation, and checks it from the
// outside with the CBI client:
//   - it refuses to start without an installation
//   - it listens on 127.0.0.1 only (LAN addresses refuse connections)
//   - CBI gets a balance over mTLS; a client without a certificate does not
//   - invalid and unknown accounts get generic errors
//   - once the process stops, CBI sees "unavailable"
// Never touches this computer's data/.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { CoreBankingError, loadCoreBankingClient } from '../lib/cbi/core-banking-client.js';
import { loadProcessEnv } from '../lib/services/process-env.js';

import { runSetup } from './setup/run.mjs';

const root = process.cwd();
const serverScript = path.join(root, 'services', 'mock-core-banking', 'server.js');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? ` -> ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function start(env) {
  const child = spawn(process.execPath, [serverScript], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not start:\n${output}`)), 10_000);
    child.stdout.on('data', () => {
      const m = output.match(/listening on https:\/\/([\d.]+):(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ address: m[1], port: Number(m[2]) });
      }
    });
    exited.then((code) => { clearTimeout(timer); reject(Object.assign(new Error(`exited with ${code}:\n${output}`), { exitCode: code })); });
  });
  listening.catch(() => {}); // only awaited by callers that expect the server to start
  return { child, exited, listening, output: () => output };
}

const tryConnect = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 1500 });
  s.on('connect', () => { s.destroy(); resolve('connected'); });
  s.on('timeout', () => { s.destroy(); resolve('timeout'); });
  s.on('error', (e) => resolve(e.code));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpay-bank-'));
let proc;
try {
  console.log('\nStart-up');
  const empty = start({ VAULTPAY_DATA_DIR: path.join(dataDir, 'not-set-up'), VAULTPAY_MOCK_BANK_PORT: '0' });
  const code = await empty.exited;
  check('refuses to start without an installation (exit 1, says run setup)', code === 1 && /npm run setup/.test(empty.output()), `${code} ${empty.output().trim()}`);

  await runSetup({ dataDir });
  proc = start({ VAULTPAY_DATA_DIR: dataDir, VAULTPAY_MOCK_BANK_PORT: '0' });
  const { address, port } = await proc.listening;
  check('started as its own process, bound to 127.0.0.1', address === '127.0.0.1', address);

  console.log('\nLocalhost only');
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  if (lan.length === 0) console.log('  SKIP  no LAN IPv4 address');
  for (const a of lan) check(`not reachable on ${a}:${port}`, (await tryConnect(a, port)) !== 'connected');

  console.log('\nmTLS and balances');
  const cbi = loadCoreBankingClient({ dataDir, port });
  const balance = await cbi.getBalance('MCB-1001');
  check('CBI gets Alice\'s balance (MCB-1001, $500.00)', balance.balanceCents === 50_000 && balance.currency === 'USD' && balance.status === 'active', JSON.stringify(balance));
  const { tls } = loadProcessEnv('cbi', { dataDir });
  const noCert = await new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/v1/accounts/MCB-1001/balance', ca: tls.ca, servername: 'localhost', agent: false, timeout: 3000 }, (res) => resolve(`HTTP ${res.statusCode}`));
    req.on('error', (e) => resolve(e.code ?? 'error'));
    req.end();
  });
  check('a client without a certificate is refused in the handshake', !noCert.startsWith('HTTP'), noCert);
  const err = async (ref) => cbi.getBalance(ref).then(() => 'ok', (e) => (e instanceof CoreBankingError ? e.code : e.message));
  check('an unknown account → not_found', (await err('MCB-9999')) === 'not_found');
  check('a malformed account → invalid_account', (await err('../etc/passwd')) === 'invalid_account');

  console.log('\nShutdown');
  proc.child.kill();
  await proc.exited;
  check('after the process stops, CBI sees "unavailable"', (await err('MCB-1001')) === 'unavailable');
  check('the service log shows no secret material', !/PRIVATE KEY|BEGIN CERTIFICATE|MOCK_CORE_BANKING_API_KEY/.test(proc.output()));
} catch (e) {
  failures += 1;
  console.log(`  FAIL  ${e.stack ?? e.message}`);
} finally {
  if (proc && proc.child.exitCode === null) {
    proc.child.kill();
    await proc.exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(failures === 0 ? '\nALL MOCK BANK CHECKS PASSED' : `\n${failures} MOCK BANK CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

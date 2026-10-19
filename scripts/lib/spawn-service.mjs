// Starts a VaultPay backend service (services/<name>/server.js) as its own Node.js process
// and waits for its "listening on https://127.0.0.1:<port>" line. Used by the real-process
// checks and by `npm run services`.

import { spawn } from 'node:child_process';
import path from 'node:path';

export function startService(name, { env = {}, root = process.cwd(), echo = false } = {}) {
  const script = path.join(root, 'services', name, 'server.js');
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  const collect = (d) => {
    output += d;
    if (echo) process.stdout.write(d);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not start:\n${output}`)), 15_000);
    child.stdout.on('data', () => {
      const m = output.match(/listening on https:\/\/([\d.]+):(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ address: m[1], port: Number(m[2]) });
      }
    });
    exited.then((code) => { clearTimeout(timer); reject(Object.assign(new Error(`${name} exited with ${code}:\n${output}`), { exitCode: code })); });
  });
  listening.catch(() => {}); // only awaited by callers that expect the service to start
  return {
    name, child, exited, listening,
    output: () => output,
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

/** Starts mock bank → Identity → CBI → Fraud & Risk → Settlement on free ports for `dataDir`. Returns { bank, identity, cbi, fraud, settlement, ports }. */
export async function startAllServices({ dataDir, root, echo = false, ports = {}, fraudEnv = {}, bankEnv = {} } = {}) {
  const base = { VAULTPAY_DATA_DIR: dataDir };
  const bank = startService('mock-core-banking', { root, echo, env: { ...base, VAULTPAY_MOCK_BANK_PORT: String(ports.bank ?? 0), ...bankEnv } });
  const bankAt = await bank.listening;
  const identity = startService('identity', { root, echo, env: { ...base, VAULTPAY_IDENTITY_PORT: String(ports.identity ?? 0) } });
  const identityAt = await identity.listening;
  const cbi = startService('cbi', { root, echo, env: { ...base, VAULTPAY_CBI_PORT: String(ports.cbi ?? 0), VAULTPAY_MOCK_BANK_PORT: String(bankAt.port) } });
  const cbiAt = await cbi.listening;
  const fraud = startService('fraud', { root, echo, env: { ...base, VAULTPAY_FRAUD_PORT: String(ports.fraud ?? 0), ...fraudEnv } });
  const fraudAt = await fraud.listening;
  const settlement = startService('settlement', { root, echo, env: {
    ...base, VAULTPAY_SETTLEMENT_PORT: String(ports.settlement ?? 0), VAULTPAY_IDENTITY_PORT: String(identityAt.port), VAULTPAY_CBI_PORT: String(cbiAt.port),
  } });
  const settlementAt = await settlement.listening;
  return {
    bank, identity, cbi, fraud, settlement,
    addresses: { bank: bankAt, identity: identityAt, cbi: cbiAt, fraud: fraudAt, settlement: settlementAt },
    ports: { bank: bankAt.port, identity: identityAt.port, cbi: cbiAt.port, fraud: fraudAt.port, settlement: settlementAt.port },
  };
}

// npm run services – starts the backend services for local development, on their
// default ports and this computer's data/: mock Core Banking (4100), Identity (4200),
// CBI (4300), Fraud & Risk (4400) and Settlement (4500). Then start the app with
// `npm run dev` in a second terminal, and `npm run fraud-worker` / `npm run
// settlement-worker` to screen and settle submitted transfers. Ctrl+C stops all.

import path from 'node:path';

import { requireNode22 } from '../lib/services/process-env.js';
import { servicePort } from '../lib/services/ports.js';

import { startAllServices } from './lib/spawn-service.mjs';

requireNode22();

const dataDir = process.env.VAULTPAY_DATA_DIR ?? path.join(process.cwd(), 'data');
let running;
try {
  running = await startAllServices({
    dataDir, echo: true,
    ports: { bank: servicePort('mock-core-banking'), identity: servicePort('identity'), cbi: servicePort('cbi'), fraud: servicePort('fraud'), settlement: servicePort('settlement') },
  });
  console.log('\nAll services running. Start the app with: npm.cmd run dev   (Ctrl+C here stops the services)');
} catch (err) {
  console.error(`\nCould not start the services: ${err.message.split('\n')[0]}`);
  process.exitCode = 1;
}

const stopAll = async () => {
  if (running) await Promise.all([running.settlement.stop(), running.fraud.stop(), running.cbi.stop(), running.identity.stop(), running.bank.stop()]);
  process.exit(process.exitCode ?? 0);
};
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
if (!running) await stopAll();

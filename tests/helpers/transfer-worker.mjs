// Worker thread for the concurrency tests: its own writable transaction-DB connection and
// transfer writer, started together with others and released at the same moment.

import { parentPort, workerData } from 'node:worker_threads';

import { openTransactionDb } from '../../lib/server/db/index.js';
import { createTransferWriter } from '../../lib/server/transfer-orchestrator.js';

const db = openTransactionDb({ dataDir: workerData.dataDir });
const writer = createTransferWriter(db);
const gate = new Int32Array(workerData.gate);
Atomics.wait(gate, 0, 0); // all workers start writing at once
let result;
try {
  const { transfer, replayed } = writer.create(workerData.request);
  result = { ok: true, transferId: transfer.transferId, replayed };
} catch (err) {
  result = { ok: false, code: err.code ?? err.name };
}
db.close();
parentPort.postMessage(result);

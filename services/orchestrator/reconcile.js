// npm run reconcile – Reconciliation & recovery as its own process (Step 8).
//
//   npm run reconcile                          keep running: one pass every 15 s
//   npm run reconcile -- --once                one pass, print a summary, exit
//   npm run reconcile -- --once --requeue-dead also give parked (dead) fraud/settlement
//                                              messages of still-pending transfers a new try
//
// A pass: expire overdue pending transfers that never reached settlement, reconcile
// ambiguous settlements with the bank (read-only), compare finished transfers with the
// bank's records, check ledger integrity (lib/orchestrator/reconciliation.js).
//
// Owns: data/secrets/recon.env – the Reconciliation client certificate (CN=vaultpay-recon)
// – and a writable transaction DB connection. Reaches Identity (VAULTPAY_IDENTITY_PORT,
// 4200) for a single-use, read-only lookup token and CBI (VAULTPAY_CBI_PORT, 4300) for the
// lookup. Holds no bank credential, no signing key and cannot post.
// VAULTPAY_RECONCILE_MIN_AGE_MS (tests/demo, 1000–3600000; default 120000): how old an
// unresolved attempt must be before reconciliation looks at it.

import { createPostingLookup, createReconciler } from '../../lib/orchestrator/reconciliation.js';
import { defaultDataDir } from '../../lib/server/db/definitions.js';
import { openTransactionDb } from '../../lib/server/db/index.js';
import { servicePort } from '../../lib/services/ports.js';
import { loadProcessEnv, requireNode22 } from '../../lib/services/process-env.js';

requireNode22();

const once = process.argv.includes('--once');
const requeue = process.argv.includes('--requeue-dead');
if (requeue && !once) {
  console.error('--requeue-dead is an operator action: use it together with --once');
  process.exit(1);
}
const dataDir = defaultDataDir();
let config;
let db;
try {
  config = loadProcessEnv('recon', { dataDir });
  db = openTransactionDb({ dataDir });
} catch (err) {
  console.error(`Reconciliation cannot start: ${err.code ?? 'ERROR'} – ${err.message}`);
  process.exit(1);
}

const identityPort = servicePort('identity');
const cbiPort = servicePort('cbi');
const minAgeSetting = Number(process.env.VAULTPAY_RECONCILE_MIN_AGE_MS);
const minAgeMs = Number.isInteger(minAgeSetting) && minAgeSetting >= 1000 && minAgeSetting <= 3_600_000 ? minAgeSetting : undefined;

const lookupPosting = createPostingLookup({ credentials: config.tls, identityPort, cbiPort });

const reconciler = createReconciler({ db, lookupPosting, minAgeMs, log: (msg) => console.log(`[reconcile] ${msg}`) });
const summary = (r) => `expired=${r.expired} requeued=${r.requeued} ${Object.entries(r.reconciled).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing to reconcile'}`
  + ` verified: ${Object.entries(r.verified).map(([k, v]) => `${k}=${v}`).join(' ') || 'none due'} integrity_issues=${r.integrityIssues}`;

if (once) {
  console.log(`[reconcile] done: ${summary(await reconciler.runOnce({ requeue }))}`);
  db.close();
} else {
  console.log('[reconcile] running (every 15 s); Ctrl+C stops');
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    console.log(`[reconcile] ${summary(await reconciler.runOnce({ requeue }))}`);
    for (let i = 0; i < 15 && !stopping; i += 1) await new Promise((r) => setTimeout(r, 1000));
  }
  db.close();
}

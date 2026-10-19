// An installation created before Step 6 (fraud.env without a certificate, no
// orchestrator.env, no fraud/orchestrator certificates) is upgraded by `npm run setup`
// without replacing any key.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import util from 'node:util';

import { hasFailures, runChecks } from '../../scripts/setup/check.mjs';
import { runSetup } from '../../scripts/setup/run.mjs';
import { freshInstall, readEnv } from '../helpers/setup.mjs';

test('a pre-Step-6 installation gets the Fraud & Risk certificate and orchestrator.env; the decision key is kept', async (t) => {
  const { dataDir } = await freshInstall(t);
  const secrets = path.join(dataDir, 'secrets');
  const fraudBefore = util.parseEnv(readEnv(dataDir, 'fraud'));
  const legacy = Object.entries(fraudBefore).filter(([k]) => !k.startsWith('TLS_')).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(secrets, 'fraud.env'), `${legacy}\n`);
  fs.rmSync(path.join(secrets, 'orchestrator.env'));
  for (const f of ['fraud.crt', 'fraud.key', 'orchestrator.crt', 'orchestrator.key']) fs.rmSync(path.join(dataDir, 'pki', f));
  const settlementBefore = readEnv(dataDir, 'settlement');
  assert.ok(hasFailures(await runChecks({ dataDir })), 'the old layout fails the check');

  const report = await runSetup({ dataDir });
  assert.ok(report.created.some((c) => /secrets upgraded \(.*fraud\.env given its certificate, orchestrator\.env added/.test(c)), report.created.join(' | '));
  assert.ok(report.created.includes('certificates upgraded (issued fraud, orchestrator from the existing CA)'), report.created.join(' | '));
  assert.ok(!hasFailures(report.checks));

  const fraud = util.parseEnv(readEnv(dataDir, 'fraud'));
  const orchestrator = util.parseEnv(readEnv(dataDir, 'orchestrator'));
  assert.equal(fraud.RISK_DECISION_SIGNING_KEY, fraudBefore.RISK_DECISION_SIGNING_KEY, 'same signing key');
  assert.equal(fraud.TLS_CERT, 'pki/fraud.crt');
  assert.equal(orchestrator.RISK_DECISION_PUBLIC_KEY, util.parseEnv(settlementBefore).RISK_DECISION_PUBLIC_KEY, 'public key matches the existing one');
  assert.ok(!('RISK_DECISION_SIGNING_KEY' in orchestrator));
  assert.equal(readEnv(dataDir, 'settlement'), settlementBefore, 'other processes untouched');
  const backup = fs.readdirSync(path.join(dataDir, 'backups')).map((d) => path.join(dataDir, 'backups', d, 'secrets', 'fraud.env')).find((p) => fs.existsSync(p));
  assert.ok(backup, 'old fraud.env backed up');

  assert.deepEqual((await runSetup({ dataDir })).created, [], 'a second run changes nothing');
});

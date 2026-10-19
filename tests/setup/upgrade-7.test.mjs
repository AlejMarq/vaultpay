// An installation created before Step 7 (settlement.env without a server certificate,
// identity.env without the risk-decision public key, no settlement-server certificate) is
// upgraded by `npm run setup` without replacing any key.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import util from 'node:util';

import { hasFailures, runChecks } from '../../scripts/setup/check.mjs';
import { runSetup } from '../../scripts/setup/run.mjs';
import { freshInstall, readEnv } from '../helpers/setup.mjs';

const write = (dataDir, proc, values) => fs.writeFileSync(path.join(dataDir, 'secrets', `${proc}.env`), `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);

test('a pre-Step-7 installation gets the Settlement server certificate and Identity the decision public key', async (t) => {
  const { dataDir } = await freshInstall(t);
  const identity = util.parseEnv(readEnv(dataDir, 'identity'));
  const settlement = util.parseEnv(readEnv(dataDir, 'settlement'));
  write(dataDir, 'identity', Object.fromEntries(Object.entries(identity).filter(([k]) => !k.startsWith('RISK_DECISION_'))));
  write(dataDir, 'settlement', Object.fromEntries(Object.entries(settlement).filter(([k]) => !k.startsWith('SERVER_TLS_'))));
  for (const f of ['settlement-server.crt', 'settlement-server.key']) fs.rmSync(path.join(dataDir, 'pki', f));
  assert.ok(hasFailures(await runChecks({ dataDir })), 'the old layout fails the check');

  const report = await runSetup({ dataDir });
  assert.ok(report.created.some((c) => /settlement\.env given its server certificate, identity\.env the risk-decision public key/.test(c)), report.created.join(' | '));
  assert.ok(report.created.includes('certificates upgraded (issued settlement-server from the existing CA)'), report.created.join(' | '));
  assert.ok(!hasFailures(report.checks));
  const after = util.parseEnv(readEnv(dataDir, 'identity'));
  assert.equal(after.SERVICE_TOKEN_SIGNING_KEY, identity.SERVICE_TOKEN_SIGNING_KEY, 'same token signing key');
  assert.equal(after.RISK_DECISION_PUBLIC_KEY, settlement.RISK_DECISION_PUBLIC_KEY);
  assert.ok(!('RISK_DECISION_SIGNING_KEY' in after), 'Identity only verifies decisions');
  assert.equal(util.parseEnv(readEnv(dataDir, 'settlement')).SERVER_TLS_CERT, 'pki/settlement-server.crt');
  assert.deepEqual((await runSetup({ dataDir })).created, [], 'a second run changes nothing');
});

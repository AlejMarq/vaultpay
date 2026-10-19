// An installation created before Step 8 (the Reconciliation certificate listed in web.env,
// no recon.env) is upgraded by `npm run setup`: the certificate moves to its own process
// file, so Next.js no longer holds a second service identity.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import util from 'node:util';

import { hasFailures, runChecks } from '../../scripts/setup/check.mjs';
import { runSetup } from '../../scripts/setup/run.mjs';
import { freshInstall, readEnv } from '../helpers/setup.mjs';

test('a pre-Step-8 installation moves the Reconciliation certificate from web.env to recon.env', async (t) => {
  const { dataDir } = await freshInstall(t);
  const secrets = path.join(dataDir, 'secrets');
  const web = util.parseEnv(readEnv(dataDir, 'web'));
  const legacy = { ...web, RECON_TLS_CERT: 'pki/recon.crt', RECON_TLS_KEY: 'pki/recon.key' };
  fs.writeFileSync(path.join(secrets, 'web.env'), `${Object.entries(legacy).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  fs.rmSync(path.join(secrets, 'recon.env'));
  const reconCert = fs.readFileSync(path.join(dataDir, 'pki', 'recon.crt'));
  assert.ok(hasFailures(await runChecks({ dataDir })), 'the old layout fails the check');

  const report = await runSetup({ dataDir });
  assert.ok(report.created.some((c) => /Reconciliation certificate moved from web\.env to recon\.env/.test(c)), report.created.join(' | '));
  assert.ok(!hasFailures(report.checks));
  const after = util.parseEnv(readEnv(dataDir, 'web'));
  assert.ok(!Object.keys(after).some((k) => k.startsWith('RECON_')), 'Next.js no longer lists the Reconciliation certificate');
  assert.equal(after.BETTER_AUTH_SECRET, web.BETTER_AUTH_SECRET, 'sessions and TOTP enrollments survive');
  const recon = util.parseEnv(readEnv(dataDir, 'recon'));
  assert.deepEqual([recon.VAULTPAY_PROCESS, recon.TLS_CERT, recon.TLS_KEY], ['recon', 'pki/recon.crt', 'pki/recon.key']);
  assert.ok(fs.readFileSync(path.join(dataDir, 'pki', 'recon.crt')).equals(reconCert), 'same certificate');
  assert.deepEqual((await runSetup({ dataDir })).created, [], 'a second run changes nothing');
});

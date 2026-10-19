// An installation created before Step 4B (signing key in web.env, no identity.env, no
// identity/web certificates) is upgraded by `npm run setup` without replacing anything.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import util from 'node:util';

import { hasFailures, runChecks } from '../../scripts/setup/check.mjs';
import { runSetup } from '../../scripts/setup/run.mjs';
import { freshInstall, readEnv, snapshot } from '../helpers/setup.mjs';

// Rewrites a fresh install into the pre-4B layout.
function makeLegacy(dataDir) {
  const identity = util.parseEnv(readEnv(dataDir, 'identity'));
  const web = util.parseEnv(readEnv(dataDir, 'web'));
  const legacyWeb = {
    VAULTPAY_PROCESS: 'web', BETTER_AUTH_SECRET: web.BETTER_AUTH_SECRET, BETTER_AUTH_URL: web.BETTER_AUTH_URL,
    SERVICE_TOKEN_SIGNING_KEY: identity.SERVICE_TOKEN_SIGNING_KEY, SERVICE_TOKEN_KEY_ID: identity.SERVICE_TOKEN_KEY_ID,
    RECON_TLS_CERT: 'pki/recon.crt', RECON_TLS_KEY: 'pki/recon.key', TLS_CA: 'pki/ca.crt',
  };
  fs.writeFileSync(path.join(dataDir, 'secrets', 'web.env'), `${Object.entries(legacyWeb).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  fs.rmSync(path.join(dataDir, 'secrets', 'identity.env'));
  for (const f of ['identity.crt', 'identity.key', 'web.crt', 'web.key']) fs.rmSync(path.join(dataDir, 'pki', f));
  return { keyId: identity.SERVICE_TOKEN_KEY_ID, signingKey: identity.SERVICE_TOKEN_SIGNING_KEY, betterAuthSecret: web.BETTER_AUTH_SECRET };
}

test('a pre-4B installation is upgraded in place: key moved, certificates added, nothing else replaced', async (t) => {
  const { dataDir } = await freshInstall(t);
  const legacy = makeLegacy(dataDir);
  assert.ok(hasFailures(await runChecks({ dataDir })), 'the legacy layout fails the check before the upgrade');
  const caBefore = fs.readFileSync(path.join(dataDir, 'pki', 'ca.crt'), 'utf8');
  const cbiEnvBefore = readEnv(dataDir, 'cbi');
  const dbBefore = snapshot(path.join(dataDir, 'db'));

  const report = await runSetup({ dataDir });
  assert.ok(report.created.some((c) => /^secrets upgraded \(service-token signing key moved from web\.env to identity\.env/.test(c)), report.created.join(' | '));
  assert.ok(report.created.includes('certificates upgraded (issued identity, web from the existing CA)'), report.created.join(' | '));
  assert.ok(!hasFailures(report.checks));

  const identity = util.parseEnv(readEnv(dataDir, 'identity'));
  const web = util.parseEnv(readEnv(dataDir, 'web'));
  assert.equal(identity.SERVICE_TOKEN_SIGNING_KEY, legacy.signingKey, 'same signing key – nothing to re-issue');
  assert.equal(identity.SERVICE_TOKEN_KEY_ID, legacy.keyId);
  assert.equal(web.BETTER_AUTH_SECRET, legacy.betterAuthSecret, 'Better Auth secret kept – sessions and TOTP enrollments survive');
  assert.ok(!('SERVICE_TOKEN_SIGNING_KEY' in web) && !('SERVICE_TOKEN_KEY_ID' in web));
  assert.equal(web.TLS_CERT, 'pki/web.crt');
  assert.equal(fs.readFileSync(path.join(dataDir, 'pki', 'ca.crt'), 'utf8'), caBefore, 'same CA');
  assert.equal(readEnv(dataDir, 'cbi'), cbiEnvBefore, 'other processes untouched');
  assert.deepEqual(snapshot(path.join(dataDir, 'db')), dbBefore, 'databases untouched');

  const backups = fs.readdirSync(path.join(dataDir, 'backups'));
  const backup = path.join(dataDir, 'backups', backups[0], 'secrets', 'web.env');
  assert.match(fs.readFileSync(backup, 'utf8'), /SERVICE_TOKEN_SIGNING_KEY=/, 'old web.env backed up');

  const again = await runSetup({ dataDir });
  assert.deepEqual(again.created, [], 'a second run changes nothing');
});

test('a half-present certificate is still a broken set (not "new"), so setup stops', async (t) => {
  const { dataDir } = await freshInstall(t);
  fs.rmSync(path.join(dataDir, 'pki', 'web.crt')); // web.key remains
  const before = snapshot(dataDir);
  await assert.rejects(runSetup({ dataDir }), /certificates exist but are incomplete or invalid.*missing: web\.crt/);
  assert.deepEqual(snapshot(dataDir), before);
});

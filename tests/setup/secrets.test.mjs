import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import util from 'node:util';

import { jwtVerify, SignJWT } from 'jose';

import { loadPrivateKey, loadPublicKey, PROCESSES, verifySecrets } from '../../scripts/setup/secrets.mjs';
import { freshInstall, readEnv, writeEnv } from '../helpers/setup.mjs';

const env = (dataDir, proc) => util.parseEnv(readEnv(dataDir, proc));

test('each process receives only its own keys', async (t) => {
  const { dataDir } = await freshInstall(t);
  const holders = (key) => PROCESSES.filter((p) => key in env(dataDir, p));
  assert.deepEqual(holders('SERVICE_TOKEN_SIGNING_KEY'), ['web']);
  assert.deepEqual(holders('RISK_DECISION_SIGNING_KEY'), ['fraud']);
  assert.deepEqual(holders('RISK_DECISION_PUBLIC_KEY'), ['settlement']);
  assert.deepEqual(holders('BETTER_AUTH_SECRET'), ['web']);
  assert.deepEqual(holders('MOCK_CORE_BANKING_API_KEY'), ['cbi', 'mock-core-banking']);
  assert.deepEqual(holders('MOCK_FRAUD_SCORING_API_KEY'), ['fraud', 'mock-fraud-scoring']);
  assert.deepEqual(holders('SERVICE_TOKEN_PUBLIC_KEY'), ['fraud', 'settlement', 'cbi']);
  for (const p of PROCESSES) {
    const text = readEnv(dataDir, p);
    assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY/, `${p}.env holds no PEM private keys`);
    assert.equal(env(dataDir, p).VAULTPAY_PROCESS, p);
  }
});

test('Node\'s built-in loader reads every env file', async (t) => {
  const { dataDir } = await freshInstall(t);
  for (const p of PROCESSES) {
    const file = path.join(dataDir, 'secrets', `${p}.env`);
    const out = execFileSync(process.execPath, ['-e', 'process.loadEnvFile(process.argv[1]); console.log(process.env.VAULTPAY_PROCESS)', file], { encoding: 'utf8' });
    assert.equal(out.trim(), p);
  }
});

test('jose: service tokens signed by Identity verify at CBI; risk decisions signed by Fraud verify at Settlement', async (t) => {
  const { dataDir } = await freshInstall(t);
  const web = env(dataDir, 'web');
  const cbi = env(dataDir, 'cbi');
  const fraud = env(dataDir, 'fraud');
  const settlement = env(dataDir, 'settlement');

  const token = await new SignJWT({ scope: 'settlement:submit', transfer_id: 'trf_1' })
    .setProtectedHeader({ alg: 'EdDSA', kid: web.SERVICE_TOKEN_KEY_ID })
    .setIssuer('vaultpay-identity').setAudience('vaultpay-cbi').setIssuedAt().setExpirationTime('60s')
    .sign(loadPrivateKey(web.SERVICE_TOKEN_SIGNING_KEY));
  const { payload, protectedHeader } = await jwtVerify(token, loadPublicKey(cbi.SERVICE_TOKEN_PUBLIC_KEY), {
    algorithms: ['EdDSA'], issuer: 'vaultpay-identity', audience: 'vaultpay-cbi',
  });
  assert.equal(payload.transfer_id, 'trf_1');
  assert.equal(protectedHeader.kid, cbi.SERVICE_TOKEN_KEY_ID);

  const decision = await new SignJWT({ outcome: 'approve', transfer_id: 'trf_1', amount_cents: 1250 })
    .setProtectedHeader({ alg: 'EdDSA', kid: fraud.RISK_DECISION_KEY_ID })
    .setIssuer('vaultpay-fraud').setAudience('vaultpay-settlement').setIssuedAt().setExpirationTime('60s')
    .sign(loadPrivateKey(fraud.RISK_DECISION_SIGNING_KEY));
  await jwtVerify(decision, loadPublicKey(settlement.RISK_DECISION_PUBLIC_KEY), { algorithms: ['EdDSA'], issuer: 'vaultpay-fraud', audience: 'vaultpay-settlement' });

  // A service token is not accepted where a risk decision is expected (different keys).
  await assert.rejects(jwtVerify(token, loadPublicKey(settlement.RISK_DECISION_PUBLIC_KEY), { algorithms: ['EdDSA'] }));
});

test('verifySecrets rejects a private key added to a process that must not hold it', async (t) => {
  const { dataDir } = await freshInstall(t);
  const fraud = env(dataDir, 'fraud');
  writeEnv(dataDir, 'settlement', `${readEnv(dataDir, 'settlement')}RISK_DECISION_SIGNING_KEY=${fraud.RISK_DECISION_SIGNING_KEY}\n`);
  assert.match(verifySecrets(path.join(dataDir, 'secrets')).problems.join(), /settlement\.env: must not contain RISK_DECISION_SIGNING_KEY/);
});

test('verifySecrets rejects weak, mismatched or escaping values', async (t) => {
  const { dataDir } = await freshInstall(t);
  const dir = path.join(dataDir, 'secrets');
  const replace = (proc, key, value) => writeEnv(dataDir, proc, readEnv(dataDir, proc).replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));

  replace('web', 'BETTER_AUTH_SECRET', 'short');
  replace('mock-core-banking', 'MOCK_CORE_BANKING_API_KEY', 'A'.repeat(43));
  replace('cbi', 'TLS_KEY', '../../outside.key');
  replace('fraud', 'SERVICE_TOKEN_KEY_ID', 'st-0000000000000000');
  const problems = verifySecrets(dir).problems.join('\n');
  assert.match(problems, /cbi\.env: TLS_KEY must point inside data\/pki/);
  // the remaining checks run once file shapes are valid
  replace('cbi', 'TLS_KEY', 'pki/cbi.key');
  const rest = verifySecrets(dir).problems.join('\n');
  assert.match(rest, /BETTER_AUTH_SECRET must be at least 32 random bytes/);
  assert.match(rest, /MOCK_CORE_BANKING_API_KEY differs between cbi\.env and mock-core-banking\.env/);
  assert.match(rest, /fraud\.env: SERVICE_TOKEN_KEY_ID does not match web's service token key/);
});

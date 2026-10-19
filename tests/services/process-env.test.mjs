import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { loadProcessEnv, ProcessConfigError } from '../../lib/services/process-env.js';
import { mockCoreBankingPort } from '../../lib/services/ports.js';
import { tempDataDir } from '../helpers/db.mjs';
import { freshInstall, readEnv, writeEnv } from '../helpers/setup.mjs';

const code = (fn) => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    assert.ok(err instanceof ProcessConfigError, err.message);
    return err.code;
  }
};

test('a process loads its own env file and TLS files, frozen, without touching process.env', async (t) => {
  const { dataDir } = await freshInstall(t);
  const before = { ...process.env };
  const { values, tls } = loadProcessEnv('mock-core-banking', { dataDir, required: ['MOCK_CORE_BANKING_API_KEY'] });
  assert.equal(values.VAULTPAY_PROCESS, 'mock-core-banking');
  assert.match(tls.cert.toString(), /BEGIN CERTIFICATE/);
  assert.match(tls.key.toString(), /PRIVATE KEY/);
  assert.ok(Object.isFrozen(values) && Object.isFrozen(tls));
  assert.deepEqual({ ...process.env }, before);
});

test('missing setup, another process\'s file, missing keys and escaping paths are refused', async (t) => {
  assert.equal(code(() => loadProcessEnv('cbi', { dataDir: path.join(tempDataDir(t), 'data') })), 'CONFIG_MISSING');
  const { dataDir } = await freshInstall(t);
  const original = readEnv(dataDir, 'cbi');
  writeEnv(dataDir, 'cbi', original.replace('VAULTPAY_PROCESS=cbi', 'VAULTPAY_PROCESS=settlement'));
  assert.equal(code(() => loadProcessEnv('cbi', { dataDir })), 'CONFIG_INVALID');
  writeEnv(dataDir, 'cbi', original.replace(/^MOCK_CORE_BANKING_API_KEY=.*\n/m, ''));
  assert.equal(code(() => loadProcessEnv('cbi', { dataDir, required: ['MOCK_CORE_BANKING_API_KEY'] })), 'CONFIG_INVALID');
  writeEnv(dataDir, 'cbi', original.replace(/^TLS_KEY=.*$/m, 'TLS_KEY=pki/../secrets/web.env'));
  assert.equal(code(() => loadProcessEnv('cbi', { dataDir })), 'CONFIG_INVALID');
  writeEnv(dataDir, 'cbi', original);
  fs.rmSync(path.join(dataDir, 'pki', 'cbi.key'));
  assert.equal(code(() => loadProcessEnv('cbi', { dataDir })), 'CONFIG_MISSING');
});

test('mock bank port: default 4100, override, 0 for tests, junk refused', () => {
  assert.equal(mockCoreBankingPort({}), 4100);
  assert.equal(mockCoreBankingPort({ VAULTPAY_MOCK_BANK_PORT: '4200' }), 4200);
  assert.equal(mockCoreBankingPort({ VAULTPAY_MOCK_BANK_PORT: '0' }), 0);
  for (const bad of ['-1', '70000', 'abc', '1.5']) assert.throws(() => mockCoreBankingPort({ VAULTPAY_MOCK_BANK_PORT: bad }));
});

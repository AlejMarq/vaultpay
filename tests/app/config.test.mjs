import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import util from 'node:util';

import { ConfigError, getWebConfig, loadWebConfig } from '../../lib/server/config.js';
import { tempDataDir } from '../helpers/db.mjs';
import { freshInstall, readEnv, writeEnv } from '../helpers/setup.mjs';

function assertConfigError(fn, code, { notContaining = [] } = {}) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, code, err.message);
    for (const secret of notContaining) assert.ok(!err.message.includes(secret), 'error message must not reveal values');
    return true;
  });
}
const replace = (dataDir, key, value) =>
  writeEnv(dataDir, 'web', readEnv(dataDir, 'web').replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));

test('loads web.env into a frozen object without touching process.env', async (t) => {
  const { dataDir } = await freshInstall(t);
  const before = { ...process.env };
  const config = loadWebConfig({ dataDir });
  assert.equal(config.VAULTPAY_PROCESS, 'web');
  assert.equal(config.BETTER_AUTH_URL, 'http://localhost:3000');
  assert.equal(config.BETTER_AUTH_SECRET, util.parseEnv(readEnv(dataDir, 'web')).BETTER_AUTH_SECRET);
  assert.ok(Object.isFrozen(config));
  assert.throws(() => { config.BETTER_AUTH_SECRET = 'x'; }, TypeError);
  assert.deepEqual({ ...process.env }, before);
  assert.equal(process.env.BETTER_AUTH_SECRET, undefined);
});

test('a missing installation says to run setup', (t) => {
  const dataDir = path.join(tempDataDir(t), 'data');
  assertConfigError(() => loadWebConfig({ dataDir }), 'CONFIG_MISSING');
  assert.match((() => { try { loadWebConfig({ dataDir }); } catch (e) { return e.message; } })(), /npm run setup/);
});

test('a missing web.env is refused', async (t) => {
  const { dataDir } = await freshInstall(t);
  fs.rmSync(path.join(dataDir, 'secrets', 'web.env'));
  assertConfigError(() => loadWebConfig({ dataDir }), 'CONFIG_MISSING');
});

test('invalid values are refused without revealing them', async (t) => {
  const { dataDir } = await freshInstall(t);
  const secret = util.parseEnv(readEnv(dataDir, 'web')).BETTER_AUTH_SECRET;
  const original = readEnv(dataDir, 'web');

  replace(dataDir, 'VAULTPAY_PROCESS', 'fraud');
  assertConfigError(() => loadWebConfig({ dataDir }), 'CONFIG_INVALID', { notContaining: [secret] });

  writeEnv(dataDir, 'web', original);
  replace(dataDir, 'BETTER_AUTH_URL', 'http://0.0.0.0:3000');
  assertConfigError(() => loadWebConfig({ dataDir }), 'CONFIG_INVALID', { notContaining: [secret] });

  writeEnv(dataDir, 'web', original);
  replace(dataDir, 'BETTER_AUTH_SECRET', 'short-secret');
  assertConfigError(() => loadWebConfig({ dataDir }), 'CONFIG_INVALID', { notContaining: ['short-secret'] });

  writeEnv(dataDir, 'web', original.replace(/^SERVICE_TOKEN_SIGNING_KEY=.*\n/m, ''));
  assertConfigError(() => loadWebConfig({ dataDir }), 'CONFIG_INVALID', { notContaining: [secret] });
});

test('a junction in place of data/secrets is refused', async (t) => {
  const { dataDir } = await freshInstall(t);
  const other = await freshInstall(t);
  fs.renameSync(path.join(dataDir, 'secrets'), path.join(dataDir, 'secrets-moved'));
  fs.symlinkSync(path.join(other.dataDir, 'secrets'), path.join(dataDir, 'secrets'), 'junction');
  assertConfigError(() => loadWebConfig({ dataDir }), 'CONFIG_UNSAFE');
});

test('getWebConfig caches a good load but not a failure', async (t) => {
  const { dataDir } = await freshInstall(t);
  const moved = path.join(dataDir, 'web.env.moved');
  fs.renameSync(path.join(dataDir, 'secrets', 'web.env'), moved);
  assertConfigError(() => getWebConfig({ dataDir }), 'CONFIG_MISSING');
  fs.renameSync(moved, path.join(dataDir, 'secrets', 'web.env'));
  const first = getWebConfig({ dataDir });
  assert.equal(getWebConfig({ dataDir }), first);
});

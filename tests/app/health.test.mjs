import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { checkHealth } from '../../lib/server/health.js';
import { tempDataDir } from '../helpers/db.mjs';
import { freshInstall } from '../helpers/setup.mjs';

const noPaths = (problems) => problems.every((p) => /^[a-z-]+:[A-Z_]+$/.test(p));

test('a complete installation is healthy', async (t) => {
  const { dataDir } = await freshInstall(t);
  let authChecked = false;
  assert.deepEqual(await checkHealth({ dataDir, checkAuth: async () => { authChecked = true; } }), { ok: true, problems: [] });
  assert.ok(authChecked);
});

test('a missing installation is unhealthy, with codes only', async (t) => {
  const dataDir = path.join(tempDataDir(t), 'data');
  const result = await checkHealth({ dataDir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['config:CONFIG_MISSING', 'identity:DB_MISSING', 'transaction:DB_MISSING']);
  assert.equal(fs.existsSync(dataDir), false, 'health never creates anything');
});

test('a tampered database is reported by code, without paths or details', async (t) => {
  const { dataDir } = await freshInstall(t);
  const raw = new Database(path.join(dataDir, 'db', 'transaction.db'));
  raw.exec('DROP TRIGGER ledger_entry_no_update');
  raw.close();
  const result = await checkHealth({ dataDir });
  assert.deepEqual(result.problems, ['transaction:DB_SCHEMA_MISMATCH']);
  assert.ok(noPaths(result.problems));
});

test('the mock Core Banking DB is not part of the app health check', async (t) => {
  const { dataDir } = await freshInstall(t);
  fs.rmSync(path.join(dataDir, 'db', 'mock-core-banking.db'));
  assert.deepEqual(await checkHealth({ dataDir }), { ok: true, problems: [] });
});

test('a Better Auth start-up failure is reported as auth:<code>', async (t) => {
  const { dataDir } = await freshInstall(t);
  const result = await checkHealth({ dataDir, checkAuth: async () => { throw Object.assign(new Error('x'), { code: 'BOOM' }); } });
  assert.deepEqual(result, { ok: false, problems: ['auth:BOOM'] });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createAuth } from '../../lib/server/auth.js';
import { DEMO_CUSTOMERS } from '../../scripts/setup/demo-data.mjs';
import { onCleanup, tempDataDir } from '../helpers/db.mjs';
import { freshInstall } from '../helpers/setup.mjs';

const REPO = process.cwd();

test('importing the auth and health modules has no side effects (build needs no data/)', (t) => {
  const empty = tempDataDir(t);
  // Import from a working directory with no data/ at all, as `next build` may.
  const script = `
    await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'lib/server/auth.js')).href)});
    await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'lib/server/health.js')).href)});
    console.log('imported');`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: empty, encoding: 'utf8' });
  assert.equal(out.trim(), 'imported');
  assert.deepEqual(fs.readdirSync(empty), [], 'nothing was created');
});

test('during `next build` the app refuses to open data/', (t) => {
  const script = `
    process.env.NEXT_PHASE = 'phase-production-build';
    const { getAuth } = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'lib/server/auth.js')).href)});
    try { getAuth(); console.log('opened'); } catch (e) { console.log('refused: ' + e.message); }`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: tempDataDir(t), encoding: 'utf8' });
  assert.match(out.trim(), /^refused: VaultPay: data\/ must not be accessed during `next build`/);
});

test('createAuth connects Better Auth to the installed identity DB', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { auth, close } = await createAuth({ dataDir });
  onCleanup(t, close);
  const alice = DEMO_CUSTOMERS[0];
  const res = await auth.api.signInEmail({ body: { email: alice.email, password: alice.password }, returnHeaders: true });
  assert.ok(res.response.token);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.deepEqual(auth.options.trustedOrigins, ['http://localhost:3000', 'http://127.0.0.1:3000']);
});

test('createAuth fails closed without web.env and never creates a database', async (t) => {
  const { dataDir } = await freshInstall(t);
  fs.rmSync(path.join(dataDir, 'secrets', 'web.env'));
  await assert.rejects(createAuth({ dataDir }), { code: 'CONFIG_MISSING' });

  const other = await freshInstall(t);
  fs.rmSync(path.join(other.dataDir, 'db', 'identity.db'));
  await assert.rejects(createAuth({ dataDir: other.dataDir }), { code: 'DB_MISSING' });
  assert.equal(fs.existsSync(path.join(other.dataDir, 'db', 'identity.db')), false);
});

test('createAuth refuses an identity DB whose Better Auth tables are incomplete', async (t) => {
  const { dataDir } = await freshInstall(t);
  const { default: Database } = await import('better-sqlite3');
  const raw = new Database(path.join(dataDir, 'db', 'identity.db'));
  raw.exec('ALTER TABLE "user" DROP COLUMN twoFactorEnabled');
  raw.close();
  await assert.rejects(createAuth({ dataDir }));
});

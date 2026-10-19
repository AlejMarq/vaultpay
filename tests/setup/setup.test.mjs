import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import util from 'node:util';

import Database from 'better-sqlite3';

import { openIdentityDb } from '../../lib/server/db/index.js';
import { migrate } from '../../lib/server/db/migrations.js';
import { inspectPermissions } from '../../scripts/setup/acl.mjs';
import { hasFailures, runChecks } from '../../scripts/setup/check.mjs';
import { runSetup } from '../../scripts/setup/run.mjs';
import { onCleanup, tempDataDir, T0 } from '../helpers/db.mjs';
import { freshInstall, pkiFile, readEnv, snapshot, writeEnv } from '../helpers/setup.mjs';

const REPO_ROOT = process.cwd();
const failing = (checks) => checks.filter((c) => c.status === 'fail').map((c) => `${c.area}: ${c.message}`);

async function rejectsSetup(dataDir, pattern, options = {}) {
  await assert.rejects(runSetup({ dataDir, ...options }), (err) => {
    assert.match(err.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Fresh install and repeatability
// ---------------------------------------------------------------------------
test('fresh setup creates every database, secret and certificate, and passes all checks', async (t) => {
  const { dataDir, report } = await freshInstall(t);
  assert.deepEqual(report.created.slice(0, 5), ['secrets', 'certificates', 'transaction database', 'identity database', 'mock-core-banking database']);
  assert.match(report.created[5], /^Better Auth schema \(create user, create session, create account, create verification, create twoFactor\)$/);
  assert.match(report.created[6], /^demo data \(/);
  assert.deepEqual(failing(report.checks), []);

  const files = Object.keys(snapshot(dataDir)).map((f) => f.replaceAll('\\', '/')).sort();
  assert.deepEqual(files, [
    'db/identity.db', 'db/mock-core-banking.db', 'db/transaction.db',
    'pki/ca.crt', 'pki/ca.key', 'pki/cbi.crt', 'pki/cbi.key', 'pki/mock-core-banking.crt', 'pki/mock-core-banking.key',
    'pki/recon.crt', 'pki/recon.key', 'pki/settlement.crt', 'pki/settlement.key',
    'secrets/cbi.env', 'secrets/fraud.env', 'secrets/mock-core-banking.env', 'secrets/mock-fraud-scoring.env',
    'secrets/settlement.env', 'secrets/web.env',
    'setup-manifest.json',
  ]);
});

test('Better Auth tables are created after VaultPay migrations and satisfy the customer foreign key', async (t) => {
  const { dataDir } = await freshInstall(t);
  const db = openIdentityDb({ dataDir });
  onCleanup(t, () => db.close());
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((r) => r.name);
  for (const name of ['user', 'session', 'account', 'verification', 'twoFactor', 'customer', 'db_meta']) assert.ok(tables.includes(name), name);
  db.prepare("INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Test', 't@example.test', 0, 1, 1)").run();
  db.prepare(`INSERT INTO customer (customer_id, auth_user_id, full_name, status, created_at) VALUES ('cus_1', 'u1', 'Test', 'active', ${T0})`).run();
});

test('running setup again changes nothing', async (t) => {
  const { dataDir } = await freshInstall(t);
  const before = snapshot(dataDir);
  const again = await runSetup({ dataDir });
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.verified, ['secrets', 'certificates', 'transaction database', 'identity database', 'mock-core-banking database', 'Better Auth schema', 'demo data']);
  assert.deepEqual(snapshot(dataDir), before);
});

test('two installations generate independent keys, certificates and databases', async (t) => {
  const a = await freshInstall(t);
  const b = await freshInstall(t);
  const ma = a.report.manifest;
  const mb = b.report.manifest;
  assert.notEqual(ma.keyIds.serviceToken, mb.keyIds.serviceToken);
  assert.notEqual(ma.keyIds.riskDecision, mb.keyIds.riskDecision);
  assert.notEqual(ma.certificates.ca.sha256, mb.certificates.ca.sha256);
  assert.notEqual(ma.databases.identity.installId, mb.databases.identity.installId);
  const secret = (d) => util.parseEnv(readEnv(d, 'web')).BETTER_AUTH_SECRET;
  assert.notEqual(secret(a.dataDir), secret(b.dataDir));
});

test('the manifest contains no secret or key material', async (t) => {
  const { dataDir } = await freshInstall(t);
  const manifest = fs.readFileSync(path.join(dataDir, 'setup-manifest.json'), 'utf8');
  for (const proc of ['web', 'fraud', 'settlement', 'cbi', 'mock-core-banking', 'mock-fraud-scoring']) {
    for (const [k, v] of Object.entries(util.parseEnv(readEnv(dataDir, proc)))) {
      if (/SECRET|KEY$|SIGNING|PUBLIC/.test(k) && !k.endsWith('KEY_ID')) assert.ok(!manifest.includes(v), `${proc} ${k} leaked into manifest`);
    }
  }
  assert.ok(!manifest.includes('PRIVATE KEY'));
});

// ---------------------------------------------------------------------------
// Never silently overwrite
// ---------------------------------------------------------------------------
test('a partial secret set stops setup and leaves the remaining files untouched', async (t) => {
  const { dataDir } = await freshInstall(t);
  fs.rmSync(path.join(dataDir, 'secrets', 'settlement.env'));
  const before = snapshot(dataDir);
  await rejectsSetup(dataDir, /secrets exist but are incomplete.*missing: settlement\.env.*--rotate-secrets/);
  assert.deepEqual(snapshot(dataDir), before);
  assert.ok(hasFailures(await runChecks({ dataDir })));
});

test('a partial certificate set stops setup and leaves the remaining files untouched', async (t) => {
  const { dataDir } = await freshInstall(t);
  fs.rmSync(pkiFile(dataDir, 'cbi.key'));
  const before = snapshot(dataDir);
  await rejectsSetup(dataDir, /certificates exist but are incomplete.*missing: cbi\.key.*--renew-certs/);
  assert.deepEqual(snapshot(dataDir), before);
});

test('an invalid existing secret is reported, not replaced', async (t) => {
  const { dataDir } = await freshInstall(t);
  // Settlement gets a risk-decision public key that does not belong to Fraud's signing key.
  const other = tempDataDir(t);
  await runSetup({ dataDir: other });
  const foreignKey = util.parseEnv(readEnv(other, 'settlement')).RISK_DECISION_PUBLIC_KEY;
  const original = readEnv(dataDir, 'settlement');
  writeEnv(dataDir, 'settlement', original.replace(/^RISK_DECISION_PUBLIC_KEY=.*$/m, `RISK_DECISION_PUBLIC_KEY=${foreignKey}`));
  await rejectsSetup(dataDir, /RISK_DECISION_PUBLIC_KEY does not match fraud's risk decision signing key/);
  assert.notEqual(readEnv(dataDir, 'settlement'), original); // still the tampered file: nothing regenerated
});

test('an existing database is never replaced, even when unreadable', async (t) => {
  const { dataDir } = await freshInstall(t);
  const file = path.join(dataDir, 'db', 'transaction.db');
  fs.writeFileSync(file, 'not a database');
  await rejectsSetup(dataDir, /not a readable SQLite database/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a database');
});

test('a missing database is recreated without touching the other one', async (t) => {
  const { dataDir } = await freshInstall(t);
  const txBefore = snapshot(path.join(dataDir, 'db'))['transaction.db'];
  fs.rmSync(path.join(dataDir, 'db', 'identity.db'));
  const report = await runSetup({ dataDir });
  assert.ok(report.created.includes('identity database'));
  assert.deepEqual(snapshot(path.join(dataDir, 'db'))['transaction.db'], txBefore);
});

test('an older database schema is backed up before being migrated', async (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  const raw = new Database(path.join(dataDir, 'db', 'transaction.db'));
  migrate(raw, 'transaction', { migrations: [], now: T0 }); // schema v0
  raw.close();

  const report = await runSetup({ dataDir });
  const line = report.created.find((c) => c.startsWith('transaction database migrated'));
  assert.match(line, /v0 → v1 \(backup: backups[\\/].+[\\/]transaction\.db\)/);
  const backup = path.join(dataDir, line.match(/backup: (.+)\)$/)[1]);
  const copy = new Database(backup, { readonly: true });
  assert.equal(copy.prepare('SELECT schema_version FROM db_meta').get().schema_version, 0);
  copy.close();
});

test('a missing Better Auth table fails the check', async (t) => {
  const { dataDir } = await freshInstall(t);
  const raw = new Database(path.join(dataDir, 'db', 'identity.db'));
  raw.exec('DROP TABLE twoFactor');
  raw.close();
  const checks = await runChecks({ dataDir });
  assert.match(failing(checks).join('\n'), /better auth: missing Better Auth tables: twoFactor/);
});

test('a second concurrent setup is refused by the lock file', async (t) => {
  const { dataDir } = await freshInstall(t);
  fs.writeFileSync(path.join(dataDir, '.setup.lock'), '{}');
  await rejectsSetup(dataDir, /another setup appears to be running/);
  assert.ok(fs.existsSync(path.join(dataDir, '.setup.lock')), 'a refused run must not remove someone else\'s lock');
});

// ---------------------------------------------------------------------------
// Explicit replacement (flags + typed confirmation)
// ---------------------------------------------------------------------------
test('replacement options do nothing without confirmation', async (t) => {
  const { dataDir } = await freshInstall(t);
  const before = snapshot(dataDir);
  for (const reset of [{ db: true }, { secrets: true }, { certs: true }]) {
    await rejectsSetup(dataDir, /was not confirmed; nothing was changed/, { reset, confirm: async () => false });
  }
  assert.deepEqual(snapshot(dataDir), before);
});

test('confirmed replacements move the old items to backups and generate new ones', async (t) => {
  const { dataDir, report: first } = await freshInstall(t);
  const asked = [];
  const report = await runSetup({ dataDir, reset: { db: true, secrets: true, certs: true }, confirm: async (r) => { asked.push(r.word); return true; } });
  assert.deepEqual(asked, ['RESET', 'ROTATE', 'RENEW']);
  const m = report.manifest;
  assert.notEqual(m.databases.identity.installId, first.manifest.databases.identity.installId);
  assert.notEqual(m.keyIds.serviceToken, first.manifest.keyIds.serviceToken);
  assert.notEqual(m.certificates.ca.sha256, first.manifest.certificates.ca.sha256);

  const archived = report.archived.map((a) => a.replaceAll('\\', '/'));
  for (const db of ['identity', 'transaction', 'mock-core-banking']) {
    assert.ok(archived.some((a) => new RegExp(`^backups/.+/db/${db}\\.db$`).test(a)), `${db} archived`);
  }
  assert.ok(archived.some((a) => /^backups\/.+\/secrets$/.test(a)));
  assert.ok(archived.some((a) => /^backups\/.+\/pki$/.test(a)));
  for (const a of report.archived) assert.ok(fs.existsSync(path.join(dataDir, a)), a);
});

// ---------------------------------------------------------------------------
// Protection of generated files
// ---------------------------------------------------------------------------
test('data/ is restricted to the current user (best-effort ACL)', async (t) => {
  const { dataDir, report } = await freshInstall(t);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(inspectPermissions(dataDir), []);
  if (process.platform === 'win32') {
    const acl = execFileSync('icacls', [path.join(dataDir, 'secrets', 'web.env')], { encoding: 'utf8' });
    assert.doesNotMatch(acl, /Everyone|BUILTIN\\Users|Authenticated Users/i);
  }
});

test('generated paths are git-ignored in this repository', () => {
  for (const p of ['data/db/identity.db', 'data/secrets/web.env', 'data/pki/ca.key', 'data/pki/cbi.crt', 'data/setup-manifest.json',
    'data/backups/x/secrets/web.env', 'elsewhere/copy.env', 'elsewhere/copy.crt', 'elsewhere/copy.key']) {
    assert.doesNotThrow(() => execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', '--', p]), `${p} must be ignored`);
  }
  assert.equal(execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', 'data'], { encoding: 'utf8' }).trim(), '');
});

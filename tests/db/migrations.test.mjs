import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { DATABASES, DB_ERROR_CODES as E } from '../../lib/server/db/index.js';
import { migrationsDir } from '../../lib/server/db/definitions.js';
import { loadMigrations, migrate } from '../../lib/server/db/migrations.js';
import { assertDbError, assertRejected, onCleanup, tempDataDir, T0 } from '../helpers/db.mjs';

const NAMES = Object.keys(DATABASES);

function copyMigrations(t, name, edit = (files) => files) {
  const dir = path.join(tempDataDir(t), 'migrations');
  fs.mkdirSync(dir);
  const files = Object.fromEntries(fs.readdirSync(migrationsDir(name)).map((f) => [f, fs.readFileSync(path.join(migrationsDir(name), f), 'utf8')]));
  for (const [f, sql] of Object.entries(edit(files))) fs.writeFileSync(path.join(dir, f), sql);
  return dir;
}

for (const name of NAMES) {
  test(`${name}: migration files are numbered 1..N and match the expected schema version`, () => {
    const migrations = loadMigrations(name);
    assert.equal(migrations.length, DATABASES[name].schemaVersion);
    migrations.forEach((m, i) => {
      assert.equal(m.version, i + 1);
      assert.match(m.sha256, /^[0-9a-f]{64}$/);
    });
  });

  test(`${name}: fresh migration records version, role and application id`, (t) => {
    const db = new Database(':memory:');
    onCleanup(t, () => db.close());
    const result = migrate(db, name, { now: T0 });
    assert.deepEqual(result, { from: 0, to: DATABASES[name].schemaVersion });

    const meta = db.prepare('SELECT role, schema_version, install_id FROM db_meta').get();
    assert.equal(meta.role, name);
    assert.equal(meta.schema_version, DATABASES[name].schemaVersion);
    assert.match(meta.install_id, /^[0-9a-f-]{36}$/);
    assert.equal(db.pragma('application_id', { simple: true }), DATABASES[name].applicationId);
    assert.equal(db.pragma('user_version', { simple: true }), DATABASES[name].schemaVersion);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, DATABASES[name].schemaVersion);
  });

  test(`${name}: running migrations again changes nothing`, (t) => {
    const db = new Database(':memory:');
    onCleanup(t, () => db.close());
    migrate(db, name, { now: T0 });
    const before = db.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all();
    assert.deepEqual(migrate(db, name, { now: T0 + 1 }), { from: 1, to: 1 });
    assert.deepEqual(db.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all(), before);
  });

  test(`${name}: CRLF line endings produce the same checksums`, (t) => {
    const dir = copyMigrations(t, name, (files) =>
      Object.fromEntries(Object.entries(files).map(([f, sql]) => [f, sql.replace(/\r?\n/g, '\r\n')])));
    assert.deepEqual(loadMigrations(name, dir).map((m) => m.sha256), loadMigrations(name).map((m) => m.sha256));
  });

  test(`${name}: a migration edited after being applied is refused`, (t) => {
    const db = new Database(':memory:');
    onCleanup(t, () => db.close());
    migrate(db, name, { now: T0 });
    const dir = copyMigrations(t, name, (files) => {
      const first = Object.keys(files).sort()[0];
      return { ...files, [first]: `${files[first]}\n-- edited\n` };
    });
    assertDbError(() => migrate(db, name, { migrations: loadMigrations(name, dir) }), E.MIGRATION_INVALID);
  });
}

test('unexpected or misnumbered migration files are refused', (t) => {
  const extra = copyMigrations(t, 'transaction', (files) => ({ ...files, 'notes.txt': 'hello' }));
  assertDbError(() => loadMigrations('transaction', extra), E.MIGRATION_INVALID);

  const gap = copyMigrations(t, 'transaction', (files) => ({ ...files, '0003_skipped.sql': 'SELECT 1;' }));
  assertDbError(() => loadMigrations('transaction', gap), E.MIGRATION_INVALID);

  const tooMany = copyMigrations(t, 'transaction', (files) => ({ ...files, '0002_future.sql': 'SELECT 1;' }));
  assertDbError(() => loadMigrations('transaction', tooMany), E.MIGRATION_INVALID);
});

test('a non-empty database that is not a VaultPay database is never adopted', (t) => {
  const db = new Database(':memory:');
  onCleanup(t, () => db.close());
  db.exec('CREATE TABLE something_else (x INTEGER)');
  assertDbError(() => migrate(db, 'transaction'), E.NOT_EMPTY);
});

test('an identity database cannot be migrated as a transaction database', (t) => {
  const db = new Database(':memory:');
  onCleanup(t, () => db.close());
  migrate(db, 'identity', { now: T0 });
  assertDbError(() => migrate(db, 'transaction'), E.WRONG_ROLE);
});

test('bookkeeping tables are protected', (t) => {
  const db = new Database(':memory:');
  onCleanup(t, () => db.close());
  migrate(db, 'transaction', { now: T0 });
  assertRejected(() => db.prepare("UPDATE db_meta SET role = 'identity'").run(), 'db_meta identity is fixed');
  assertRejected(() => db.prepare('UPDATE db_meta SET schema_version = 0').run(), 'only increases');
  assertRejected(() => db.prepare('DELETE FROM db_meta').run(), 'cannot be deleted');
  assertRejected(() => db.prepare("UPDATE schema_migrations SET sha256 = 'x'").run(), 'append-only');
  assertRejected(() => db.prepare('DELETE FROM schema_migrations').run(), 'append-only');
  assertRejected(() => db.prepare("INSERT INTO db_meta (id, role, install_id, schema_version, created_at) VALUES (2, 'x', 'y', 0, 1)").run());
});

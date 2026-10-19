import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import {
  checkIntegrity,
  createDatabase,
  DB_ERROR_CODES as E,
  migrateDatabase,
  openDatabase,
  openIdentityDb,
  openTransactionDb,
} from '../../lib/server/db/index.js';
import { loadMigrations, migrate } from '../../lib/server/db/migrations.js';
import { addAuthUserStub, assertDbError, onCleanup, tempDataDir, T0 } from '../helpers/db.mjs';

const dbFile = (dataDir, name) => path.join(dataDir, 'db', `${name}.db`);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Writes directly to a database file, bypassing every VaultPay check (simulates tampering).
function tamper(file, sql) {
  const raw = new Database(file);
  try {
    raw.exec(sql);
  } finally {
    raw.close();
  }
}

// Builds a database file by hand (for states createDatabase refuses to produce).
function handBuilt(dataDir, name, build) {
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  const raw = new Database(dbFile(dataDir, name));
  try {
    build(raw);
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------
test('createDatabase builds both databases that then open cleanly', (t) => {
  const dataDir = tempDataDir(t);
  for (const name of ['identity', 'transaction']) {
    assert.equal(createDatabase(name, { dataDir }), dbFile(dataDir, name));
    const db = openDatabase(name, { dataDir });
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('trusted_schema', { simple: true }), 0);
    db.close();
  }
  openIdentityDb({ dataDir }).close();
  openTransactionDb({ dataDir }).close();
  // no temporary build files left behind
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'db')).filter((f) => f.endsWith('.tmp')), []);
});

test('createDatabase never overwrites an existing database', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  const before = sha(dbFile(dataDir, 'transaction'));
  assertDbError(() => createDatabase('transaction', { dataDir }), E.EXISTS);
  assert.equal(sha(dbFile(dataDir, 'transaction')), before);
});

test('createDatabase refuses to create over any existing file, even a non-database', (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(path.join(dataDir, 'db'));
  fs.writeFileSync(dbFile(dataDir, 'identity'), 'keep me');
  assertDbError(() => createDatabase('identity', { dataDir }), E.EXISTS);
  assert.equal(fs.readFileSync(dbFile(dataDir, 'identity'), 'utf8'), 'keep me');
});

test('two installations get different install ids', (t) => {
  const ids = [tempDataDir(t), tempDataDir(t)].map((dataDir) => {
    createDatabase('transaction', { dataDir });
    const db = openDatabase('transaction', { dataDir, readonly: true });
    const id = db.prepare('SELECT install_id FROM db_meta').get().install_id;
    db.close();
    return id;
  });
  assert.notEqual(ids[0], ids[1]);
});

// ---------------------------------------------------------------------------
// Fail-closed opening
// ---------------------------------------------------------------------------
test('a missing database is refused and NOT created', (t) => {
  const dataDir = tempDataDir(t);
  assertDbError(() => openDatabase('identity', { dataDir }), E.MISSING);
  fs.mkdirSync(path.join(dataDir, 'db'));
  assertDbError(() => openDatabase('identity', { dataDir }), E.MISSING);
  assert.equal(fs.existsSync(dbFile(dataDir, 'identity')), false);
});

test('only known database names are accepted (no paths)', (t) => {
  const dataDir = tempDataDir(t);
  for (const name of ['../identity', 'identity.db', 'Identity', '', undefined, 'constructor', '__proto__']) {
    assertDbError(() => openDatabase(name, { dataDir }), E.UNKNOWN);
  }
});

test('read-only connections are enforced by SQLite', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  const ro = openDatabase('transaction', { dataDir, readonly: true });
  onCleanup(t, () => ro.close());
  assert.throws(
    () => ro.prepare("INSERT INTO audit_event (event_id, actor_type, actor_id, event_type, occurred_at) VALUES ('aud_1', 'service', 'x', 'test', 1)").run(),
    { code: 'SQLITE_READONLY' },
  );
});

test('a file that is not SQLite is refused', (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(path.join(dataDir, 'db'));
  fs.writeFileSync(dbFile(dataDir, 'transaction'), crypto.randomBytes(8192));
  assertDbError(() => openDatabase('transaction', { dataDir }), E.NOT_A_DATABASE);
});

test('an empty SQLite file (no VaultPay metadata) is refused', (t) => {
  const dataDir = tempDataDir(t);
  handBuilt(dataDir, 'transaction', (raw) => raw.exec('CREATE TABLE x (y INTEGER)'));
  assertDbError(() => openDatabase('transaction', { dataDir }), E.WRONG_ROLE);
});

test('the identity database cannot be opened as the transaction database', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('identity', { dataDir });
  fs.copyFileSync(dbFile(dataDir, 'identity'), dbFile(dataDir, 'transaction'));
  assertDbError(() => openDatabase('transaction', { dataDir }), E.WRONG_ROLE);
});

test('a changed db_meta role is refused even if application_id matches', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  tamper(dbFile(dataDir, 'transaction'), "DROP TRIGGER db_meta_fixed_identity; UPDATE db_meta SET role = 'identity';");
  assertDbError(() => openDatabase('transaction', { dataDir }), E.WRONG_ROLE);
});

test('an older schema is refused with a "run setup" error', (t) => {
  const dataDir = tempDataDir(t);
  handBuilt(dataDir, 'transaction', (raw) => migrate(raw, 'transaction', { migrations: [], now: T0 }));
  assertDbError(() => openDatabase('transaction', { dataDir }), E.VERSION_OLD);
});

test('migrateDatabase upgrades an older schema, after which it opens', (t) => {
  const dataDir = tempDataDir(t);
  handBuilt(dataDir, 'transaction', (raw) => migrate(raw, 'transaction', { migrations: [], now: T0 }));
  assert.deepEqual(migrateDatabase('transaction', { dataDir }), { from: 0, to: 1 });
  openDatabase('transaction', { dataDir }).close();
  assert.deepEqual(migrateDatabase('transaction', { dataDir }), { from: 1, to: 1 });
});

test('a schema newer than the code is refused', (t) => {
  const dataDir = tempDataDir(t);
  const future = [...loadMigrations('transaction'), { version: 2, name: 'future', sql: 'CREATE TABLE future_table (x INTEGER) STRICT;', sha256: 'f'.repeat(64) }];
  handBuilt(dataDir, 'transaction', (raw) => migrate(raw, 'transaction', { migrations: future, now: T0 }));
  assertDbError(() => openDatabase('transaction', { dataDir }), E.VERSION_NEW);
  assertDbError(() => migrateDatabase('transaction', { dataDir }), E.VERSION_NEW);
});

test('disagreeing version markers are refused', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  tamper(dbFile(dataDir, 'transaction'), 'PRAGMA user_version = 7;');
  assertDbError(() => openDatabase('transaction', { dataDir }), E.SCHEMA_MISMATCH);
});

// ---------------------------------------------------------------------------
// Schema validation – dropped, altered or added objects
// ---------------------------------------------------------------------------
test('a dropped append-only trigger is detected', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  tamper(dbFile(dataDir, 'transaction'), 'DROP TRIGGER ledger_entry_no_update;');
  assert.throws(() => openDatabase('transaction', { dataDir }), (err) => {
    assert.equal(err.code, E.SCHEMA_MISMATCH);
    assert.deepEqual(err.details, ['missing trigger ledger_entry_no_update']);
    return true;
  });
});

test('a trigger replaced with a harmless body of the same name is detected', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  tamper(dbFile(dataDir, 'transaction'), `
    DROP TRIGGER ledger_entry_no_delete;
    CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger_entry BEGIN SELECT 1; END;`);
  assert.throws(() => openDatabase('transaction', { dataDir }), (err) => {
    assert.equal(err.code, E.SCHEMA_MISMATCH);
    assert.deepEqual(err.details, ['changed trigger ledger_entry_no_delete']);
    return true;
  });
});

test('an extra table, index or trigger is detected', (t) => {
  for (const sql of [
    'CREATE TABLE shadow_ledger (x INTEGER);',
    'CREATE INDEX extra_idx ON transfer (currency);',
    "CREATE TRIGGER copy_out AFTER INSERT ON transfer BEGIN SELECT 1; END;",
  ]) {
    const dataDir = tempDataDir(t);
    createDatabase('transaction', { dataDir });
    tamper(dbFile(dataDir, 'transaction'), sql);
    assertDbError(() => openDatabase('transaction', { dataDir }), E.SCHEMA_MISMATCH);
  }
});

test('a weakened CHECK constraint (table rebuilt, triggers restored) is detected', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  // Rebuild reconciliation_result without its CHECK, then put its index and triggers back
  // exactly as they were – only the table definition differs afterwards.
  const raw = new Database(dbFile(dataDir, 'transaction'));
  try {
    const objects = raw.prepare("SELECT type, sql FROM sqlite_schema WHERE tbl_name = 'reconciliation_result' AND sql IS NOT NULL").all();
    const table = objects.find((o) => o.type === 'table').sql;
    const weakened = table.replace("CHECK (result = 'mismatched' OR difference_cents IS NULL)", 'CHECK (1)');
    assert.notEqual(weakened, table);
    raw.exec('DROP TABLE reconciliation_result');
    raw.exec(weakened);
    for (const o of objects.filter((x) => x.type !== 'table')) raw.exec(o.sql);
  } finally {
    raw.close();
  }
  assert.throws(() => openDatabase('transaction', { dataDir }), (err) => {
    assert.equal(err.code, E.SCHEMA_MISMATCH);
    assert.deepEqual(err.details, ['changed table reconciliation_result']);
    return true;
  });
});

test('direct edits of the schema table are blocked by SQLite defensive mode', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  assert.throws(() => tamper(dbFile(dataDir, 'transaction'), `
    PRAGMA writable_schema = ON;
    UPDATE sqlite_schema SET sql = replace(sql, 'BETWEEN 1 AND', 'BETWEEN -1000000 AND') WHERE name = 'ledger_entry';`),
  /may not be modified/);
});

test('Better Auth tables are allowed in the identity DB, but not triggers on them', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('identity', { dataDir });
  tamper(dbFile(dataDir, 'identity'), `
    CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT);
    CREATE INDEX user_email ON "user" (email);
    CREATE TABLE session (id TEXT PRIMARY KEY);`);
  openDatabase('identity', { dataDir }).close();

  tamper(dbFile(dataDir, 'identity'), 'CREATE TRIGGER leak AFTER INSERT ON session BEGIN SELECT 1; END;');
  assertDbError(() => openDatabase('identity', { dataDir }), E.SCHEMA_MISMATCH);
});

test('Better Auth table names are not allowed in the transaction DB', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  tamper(dbFile(dataDir, 'transaction'), 'CREATE TABLE session (id TEXT PRIMARY KEY);');
  assertDbError(() => openDatabase('transaction', { dataDir }), E.SCHEMA_MISMATCH);
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------
test('a junction or symlink in place of data/db is refused', (t) => {
  const dataDir = tempDataDir(t);
  const elsewhere = tempDataDir(t);
  createDatabase('transaction', { dataDir: elsewhere });
  fs.symlinkSync(path.join(elsewhere, 'db'), path.join(dataDir, 'db'), 'junction');
  assertDbError(() => openDatabase('transaction', { dataDir }), E.UNSAFE_PATH);
  assertDbError(() => createDatabase('identity', { dataDir }), E.UNSAFE_PATH);
});

test('a symlinked database file is refused', (t) => {
  const dataDir = tempDataDir(t);
  const elsewhere = tempDataDir(t);
  createDatabase('transaction', { dataDir: elsewhere });
  fs.mkdirSync(path.join(dataDir, 'db'));
  try {
    fs.symlinkSync(dbFile(elsewhere, 'transaction'), dbFile(dataDir, 'transaction'), 'file');
  } catch (err) {
    // File symlinks on Windows need Developer Mode or admin rights.
    if (err.code === 'EPERM') return t.skip('file symlinks not permitted for this Windows user');
    throw err;
  }
  assertDbError(() => openDatabase('transaction', { dataDir }), E.UNSAFE_PATH);
});

test('a hard-linked database file is refused', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  fs.linkSync(dbFile(dataDir, 'transaction'), path.join(dataDir, 'copy.db'));
  assertDbError(() => openDatabase('transaction', { dataDir }), E.UNSAFE_PATH);
});

test('a directory in place of the database file is refused', (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(dbFile(dataDir, 'transaction'), { recursive: true });
  assertDbError(() => openDatabase('transaction', { dataDir }), E.UNSAFE_PATH);
});

// ---------------------------------------------------------------------------
// Full integrity check
// ---------------------------------------------------------------------------
test('checkIntegrity passes on fresh databases', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  createDatabase('identity', { dataDir });
  const tx = openTransactionDb({ dataDir });
  const id = openIdentityDb({ dataDir });
  onCleanup(t, () => { tx.close(); id.close(); });
  checkIntegrity(tx);
  addAuthUserStub(id, 'usr_1');
  checkIntegrity(id);
});

test('checkIntegrity reports foreign key violations', (t) => {
  const dataDir = tempDataDir(t);
  createDatabase('transaction', { dataDir });
  tamper(dbFile(dataDir, 'transaction'), `
    PRAGMA foreign_keys = OFF;
    INSERT INTO audit_event (event_id, transfer_id, actor_type, actor_id, event_type, occurred_at)
    VALUES ('aud_orphan', 'trf_missing', 'service', 'test', 'test.event', 1);`);
  const db = openTransactionDb({ dataDir });
  onCleanup(t, () => db.close());
  assertDbError(() => checkIntegrity(db), E.INTEGRITY);
});

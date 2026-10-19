// Safe creation and opening of VaultPay SQLite databases. Every check fails closed:
// on any doubt the connection is closed and a DbError is thrown. Nothing here ever
// creates a database implicitly – only createDatabase() does, and never over a file.
//
// These checks catch mistakes and mix-ups (wrong file, stale schema, dropped trigger,
// a link pointing elsewhere). They are not a boundary against someone who can already
// write to data/ (D3, D4).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { defaultDataDir, getDefinition } from './definitions.js';
import { DB_ERROR_CODES as E, DbError } from './errors.js';
import { expectedSchemaObjects, loadMigrations, migrate, readMeta, schemaObjects, verifyAppliedMigrations } from './migrations.js';

const BUSY_TIMEOUT_MS = 5000;
const SIDE_FILE_SUFFIXES = ['-wal', '-shm', '-journal'];

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function lstatOrUndefined(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw new DbError(E.UNSAFE_PATH, `cannot inspect ${p} (${err.code})`);
  }
}

function locate(name, dataDir) {
  const def = getDefinition(name);
  // turbopackIgnore: runtime data, never traced into build output (see definitions.js)
  const root = path.resolve(/* turbopackIgnore: true */ dataDir);
  const dir = path.join(/* turbopackIgnore: true */ root, 'db');
  return { def, root, dir, file: path.join(/* turbopackIgnore: true */ dir, def.fileName) };
}

// data/ and data/db must be real directories (not symlinks or junctions).
function assertSafeDirectories({ root, dir }) {
  for (const p of [root, dir]) {
    const st = lstatOrUndefined(p);
    if (!st) throw new DbError(E.MISSING, `directory does not exist: ${p}`);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new DbError(E.UNSAFE_PATH, `not a plain directory (link or file): ${p}`);
    }
  }
}

// The database file must be a single, regular file directly inside data/db, and any
// SQLite side files next to it must be regular files too.
function assertSafeFile(loc) {
  assertSafeDirectories(loc);
  const st = lstatOrUndefined(loc.file);
  if (!st) throw new DbError(E.MISSING, `${loc.def.name} database does not exist: ${loc.file}`);
  if (st.isSymbolicLink() || !st.isFile()) throw new DbError(E.UNSAFE_PATH, `not a regular file: ${loc.file}`);
  if (st.nlink > 1) throw new DbError(E.UNSAFE_PATH, `database file has ${st.nlink} hard links: ${loc.file}`);

  const real = fs.realpathSync.native(loc.file);
  const expected = path.join(/* turbopackIgnore: true */ fs.realpathSync.native(loc.root), 'db', loc.def.fileName);
  if (!samePath(real, expected)) throw new DbError(E.UNSAFE_PATH, `database path resolves elsewhere: ${real}`);

  for (const suffix of SIDE_FILE_SUFFIXES) {
    const side = lstatOrUndefined(loc.file + suffix);
    if (side && (side.isSymbolicLink() || !side.isFile())) {
      throw new DbError(E.UNSAFE_PATH, `not a regular file: ${loc.file + suffix}`);
    }
  }
}

function sqliteFailure(err, file) {
  if (err instanceof DbError) return err;
  if (err?.code === 'SQLITE_NOTADB' || err?.code === 'SQLITE_CANTOPEN') {
    return new DbError(E.NOT_A_DATABASE, `not a readable SQLite database: ${file} (${err.code})`);
  }
  if (err?.code?.startsWith('SQLITE_CORRUPT')) {
    return new DbError(E.INTEGRITY, `database is corrupt: ${file} (${err.code})`);
  }
  return err;
}

// Diff two schema object lists by "type name". Returns human-readable problems.
function diffSchema(expected, actual) {
  const key = (o) => `${o.type} ${o.name}`;
  const want = new Map(expected.map((o) => [key(o), o]));
  const have = new Map(actual.map((o) => [key(o), o]));
  const problems = [];
  for (const [k, o] of want) {
    if (!have.has(k)) problems.push(`missing ${k}`);
    else if (have.get(k).sql !== o.sql || have.get(k).tableName !== o.tableName) problems.push(`changed ${k}`);
  }
  for (const k of have.keys()) if (!want.has(k)) problems.push(`unexpected ${k}`);
  return problems;
}

// Checks run on every open. `db` must already be connected; throws DbError on failure.
function verifyConnection(db, def) {
  db.pragma('trusted_schema = OFF');
  db.pragma('foreign_keys = ON');
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new DbError(E.INTEGRITY, 'foreign key enforcement could not be enabled');
  }

  const quick = db.pragma('quick_check', { simple: true });
  if (quick !== 'ok') throw new DbError(E.INTEGRITY, `${def.name} database failed quick_check: ${quick}`);

  const meta = readMeta(db);
  if (db.pragma('application_id', { simple: true }) !== def.applicationId || meta?.role !== def.name) {
    throw new DbError(E.WRONG_ROLE, `file is not a VaultPay ${def.name} database`);
  }

  if (meta.schema_version < def.schemaVersion) {
    throw new DbError(E.VERSION_OLD, `${def.name} database is at schema v${meta.schema_version}, code needs v${def.schemaVersion}; run npm run setup`);
  }
  if (meta.schema_version > def.schemaVersion) {
    throw new DbError(E.VERSION_NEW, `${def.name} database is at schema v${meta.schema_version}, newer than this code (v${def.schemaVersion})`);
  }

  const migrations = loadMigrations(def.name);
  const applied = verifyAppliedMigrations(db, def.name, migrations);
  const userVersion = db.pragma('user_version', { simple: true });
  if (applied !== meta.schema_version || userVersion !== meta.schema_version) {
    throw new DbError(E.SCHEMA_MISMATCH, `${def.name} version markers disagree (db_meta ${meta.schema_version}, migrations ${applied}, user_version ${userVersion})`);
  }

  // Tables and indexes owned by Better Auth are allowed; triggers or views on them are not.
  const external = new Set(def.externalTables);
  const actual = schemaObjects(db).filter((o) => !((o.type === 'table' || o.type === 'index') && external.has(o.tableName)));
  const problems = diffSchema(expectedSchemaObjects(def.name, migrations), actual);
  if (problems.length > 0) {
    throw new DbError(E.SCHEMA_MISMATCH, `${def.name} schema differs from its migrations: ${problems.join('; ')}`, problems);
  }
}

/**
 * Opens an existing VaultPay database after path, integrity, identity, version and schema
 * checks. readonly connections are enforced by SQLite itself (SQLITE_READONLY).
 */
export function openDatabase(name, { dataDir = defaultDataDir(), readonly = false } = {}) {
  const loc = locate(name, dataDir);
  assertSafeFile(loc);

  let db;
  try {
    db = new Database(loc.file, { readonly, fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    verifyConnection(db, loc.def);
    if (!readonly && db.pragma('journal_mode', { simple: true }) !== 'wal') db.pragma('journal_mode = WAL');
    return db;
  } catch (err) {
    db?.close();
    throw sqliteFailure(err, loc.file);
  }
}

export const openIdentityDb = (options) => openDatabase('identity', options);
export const openTransactionDb = (options) => openDatabase('transaction', options);
export const openMockCoreBankingDb = (options) => openDatabase('mock-core-banking', options);

/**
 * Creates a new database at its fixed location. The file is built under a temporary
 * name and only linked into place once fully migrated and verified, so an interrupted
 * run never leaves a half-built database behind. Refuses if the file already exists.
 */
export function createDatabase(name, { dataDir = defaultDataDir(), now = Date.now() } = {}) {
  const loc = locate(name, dataDir);
  fs.mkdirSync(loc.dir, { recursive: true });
  assertSafeDirectories(loc);
  if (lstatOrUndefined(loc.file)) throw new DbError(E.EXISTS, `${name} database already exists: ${loc.file}`);

  const tmp = path.join(loc.dir, `.${loc.def.fileName}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let db;
  try {
    db = new Database(tmp);
    db.pragma('journal_mode = WAL');
    migrate(db, name, { now });
    verifyConnection(db, loc.def);
    db.close();
    db = undefined;
    try {
      fs.linkSync(tmp, loc.file); // fails with EEXIST instead of replacing a file created meanwhile
    } catch (err) {
      if (err.code === 'EEXIST') throw new DbError(E.EXISTS, `${name} database already exists: ${loc.file}`);
      throw err;
    }
  } finally {
    db?.close();
    for (const suffix of ['', ...SIDE_FILE_SUFFIXES]) fs.rmSync(tmp + suffix, { force: true });
  }
  return loc.file;
}

/**
 * Applies pending migrations to an existing database (used by setup). The file must
 * already be a VaultPay database of the right kind; it is verified again afterwards.
 */
export function migrateDatabase(name, { dataDir = defaultDataDir(), now = Date.now() } = {}) {
  const loc = locate(name, dataDir);
  assertSafeFile(loc);
  let db;
  try {
    db = new Database(loc.file, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    db.pragma('trusted_schema = OFF');
    db.pragma('foreign_keys = ON');
    const quick = db.pragma('quick_check', { simple: true });
    if (quick !== 'ok') throw new DbError(E.INTEGRITY, `${name} database failed quick_check: ${quick}`);
    const result = migrate(db, name, { now });
    verifyConnection(db, loc.def);
    return result;
  } catch (err) {
    throw sqliteFailure(err, loc.file);
  } finally {
    db?.close();
  }
}

/**
 * Writes a consistent copy of an existing database (including un-checkpointed WAL
 * content) to `destination`, which must not exist. Used by setup before migrating.
 * Only path checks are applied, so an older schema can still be backed up.
 */
export async function backupDatabase(name, destination, { dataDir = defaultDataDir() } = {}) {
  const loc = locate(name, dataDir);
  assertSafeFile(loc);
  if (lstatOrUndefined(destination)) throw new DbError(E.EXISTS, `backup destination already exists: ${destination}`);
  const db = new Database(loc.file, { readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
  try {
    await db.backup(destination);
  } catch (err) {
    throw sqliteFailure(err, loc.file);
  } finally {
    db.close();
  }
  return destination;
}

/**
 * Full integrity check for setup:check and tests: integrity_check plus foreign_key_check.
 * Slower than the quick_check done on every open.
 */
export function checkIntegrity(db) {
  const rows = db.pragma('integrity_check');
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
    throw new DbError(E.INTEGRITY, `integrity_check failed: ${rows.map((r) => r.integrity_check).join('; ')}`);
  }
  let fk;
  try {
    fk = db.pragma('foreign_key_check');
  } catch (err) {
    throw new DbError(E.INTEGRITY, `foreign_key_check failed: ${err.message}`);
  }
  if (fk.length > 0) {
    throw new DbError(E.INTEGRITY, `foreign_key_check found ${fk.length} violation(s), first in table ${fk[0].table}`);
  }
}

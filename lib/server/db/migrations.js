// Versioned SQL migrations.
//
// Files live in lib/server/db/migrations/<database>/NNNN_name.sql, numbered 1..N with no
// gaps. Each file is applied once, inside its own transaction, and its SHA-256 is recorded
// in schema_migrations. Later runs refuse to continue if an applied file was edited,
// removed, or if the database is newer than the code.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getDefinition, migrationsDir } from './definitions.js';
import { DB_ERROR_CODES as E, DbError } from './errors.js';

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

// Bookkeeping tables shared by every VaultPay database. Applied before migration 0001.
// Frozen: existing databases are compared against this text, so changes need a migration.
const BOOTSTRAP_SQL = `
CREATE TABLE db_meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  role           TEXT    NOT NULL,
  install_id     TEXT    NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  created_at     INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TRIGGER db_meta_fixed_identity BEFORE UPDATE ON db_meta
WHEN NEW.id IS NOT OLD.id
  OR NEW.role IS NOT OLD.role
  OR NEW.install_id IS NOT OLD.install_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.schema_version < OLD.schema_version
BEGIN SELECT RAISE(ABORT, 'db_meta identity is fixed and schema_version only increases'); END;

CREATE TRIGGER db_meta_no_delete BEFORE DELETE ON db_meta
BEGIN SELECT RAISE(ABORT, 'db_meta cannot be deleted'); END;

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY CHECK (version > 0),
  name       TEXT    NOT NULL,
  sha256     TEXT    NOT NULL CHECK (length(sha256) = 64),
  applied_at INTEGER NOT NULL CHECK (applied_at > 0)
) STRICT;

CREATE TRIGGER schema_migrations_no_update BEFORE UPDATE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'schema_migrations is append-only'); END;

CREATE TRIGGER schema_migrations_no_delete BEFORE DELETE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'schema_migrations is append-only'); END;
`;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Reads and validates the migration files for one database. Line endings are normalized
// so a Windows checkout produces the same checksums as an LF checkout.
export function loadMigrations(name, dir = migrationsDir(name)) {
  const def = getDefinition(name);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new DbError(E.MIGRATION_INVALID, `cannot read ${name} migrations (${err.code ?? err.message})`);
  }

  const migrations = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry.name);
    if (!entry.isFile() || !match) {
      throw new DbError(E.MIGRATION_INVALID, `unexpected entry in ${name} migrations: ${entry.name}`);
    }
    const sql = fs.readFileSync(path.join(dir, entry.name), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    migrations.push({ version: Number(match[1]), name: match[2], sql, sha256: sha256(sql) });
  }

  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new DbError(E.MIGRATION_INVALID, `${name} migrations must be numbered 0001..N without gaps (found ${String(m.version).padStart(4, '0')})`);
    }
  });
  if (migrations.length !== def.schemaVersion) {
    throw new DbError(E.MIGRATION_INVALID, `code expects ${name} schema v${def.schemaVersion} but ${migrations.length} migration file(s) exist`);
  }
  return migrations;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

export function readMeta(db) {
  if (!tableExists(db, 'db_meta')) return undefined;
  return db.prepare('SELECT role, install_id, schema_version, created_at FROM db_meta WHERE id = 1').get();
}

// Compares what the database says was applied with the files on disk.
// Returns the number of applied migrations.
export function verifyAppliedMigrations(db, name, migrations) {
  const applied = db.prepare('SELECT version, name, sha256 FROM schema_migrations ORDER BY version').all();
  applied.forEach((row, i) => {
    if (row.version !== i + 1) {
      throw new DbError(E.SCHEMA_MISMATCH, `${name} schema_migrations has a gap at version ${i + 1}`);
    }
    const file = migrations[i];
    if (!file) {
      throw new DbError(E.VERSION_NEW, `${name} database has migration ${row.version} (${row.name}) that this code does not know`);
    }
    if (file.name !== row.name || file.sha256 !== row.sha256) {
      throw new DbError(E.MIGRATION_INVALID, `${name} migration ${String(row.version).padStart(4, '0')}_${row.name} differs from the applied version`);
    }
  });
  return applied.length;
}

// Brings `db` to the latest schema. A brand-new (empty) database is initialized first;
// a non-empty database without db_meta is refused rather than adopted.
export function migrate(db, name, { migrations = loadMigrations(name), now = Date.now() } = {}) {
  const def = getDefinition(name);

  if (!tableExists(db, 'db_meta')) {
    const objects = db.prepare('SELECT count(*) AS n FROM sqlite_schema').get().n;
    if (objects > 0) {
      throw new DbError(E.NOT_EMPTY, `refusing to initialize a ${name} database in a file that already has ${objects} schema object(s)`);
    }
    db.transaction(() => {
      db.exec(BOOTSTRAP_SQL);
      db.prepare('INSERT INTO db_meta (id, role, install_id, schema_version, created_at) VALUES (1, ?, ?, 0, ?)')
        .run(def.name, crypto.randomUUID(), now);
      db.pragma(`application_id = ${def.applicationId}`);
    })();
  }

  const meta = readMeta(db);
  if (meta?.role !== def.name || db.pragma('application_id', { simple: true }) !== def.applicationId) {
    throw new DbError(E.WRONG_ROLE, `database is not a VaultPay ${name} database`);
  }

  const from = verifyAppliedMigrations(db, name, migrations);
  if (meta.schema_version !== from) {
    throw new DbError(E.SCHEMA_MISMATCH, `${name} db_meta.schema_version (${meta.schema_version}) does not match schema_migrations (${from})`);
  }

  const record = db.prepare('INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)');
  const bump = db.prepare('UPDATE db_meta SET schema_version = ? WHERE id = 1');
  for (const m of migrations.slice(from)) {
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, m.sha256, now);
      bump.run(m.version);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return { from, to: migrations.length };
}

// The schema a correctly migrated database must have, built once per process in memory
// from the same files. Compared object-by-object on every open.
const expectedCache = new Map();

export function schemaObjects(db) {
  return db.prepare(String.raw`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\'
    ORDER BY type, name`).all();
}

export function expectedSchemaObjects(name, migrations = loadMigrations(name)) {
  const key = `${name}:${migrations.map((m) => m.sha256).join(',')}`;
  if (!expectedCache.has(key)) {
    const mem = new Database(':memory:');
    try {
      migrate(mem, name, { migrations, now: 1 });
      expectedCache.set(key, schemaObjects(mem));
    } finally {
      mem.close();
    }
  }
  return expectedCache.get(key);
}

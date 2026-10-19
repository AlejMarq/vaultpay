// Database step of setup.
//
// Order (approved decision 4): VaultPay migrations first, then Better Auth's migrations,
// so Better Auth's "user" table exists before any customer or ops record can be created.
// Existing databases are never replaced; an older schema is backed up, then migrated.

import fs from 'node:fs';
import path from 'node:path';

import { getMigrations } from 'better-auth/db/migration';

import { BETTER_AUTH_TABLES, buildAuthOptions } from '../../lib/server/auth-config.js';
import {
  backupDatabase,
  createDatabase,
  DB_ERROR_CODES,
  migrateDatabase,
  openDatabase,
  openIdentityDb,
} from '../../lib/server/db/index.js';

import { layout, lstatOrUndefined } from './paths.mjs';

export const DATABASE_NAMES = Object.freeze(['transaction', 'identity', 'mock-core-banking']);

const authOptionsFor = (db, secret) => buildAuthOptions({ database: db, secret, baseURL: 'http://localhost:3000' });

/** Problems with Better Auth's tables in an open identity DB (empty array = OK). */
export async function inspectAuthSchema(db, secret) {
  const problems = [];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((r) => r.name));
  const missing = BETTER_AUTH_TABLES.filter((t) => !tables.has(t));
  if (missing.length) problems.push(`missing Better Auth tables: ${missing.join(', ')}`);

  const plan = await getMigrations(authOptionsFor(db, secret), { throwOnUnsafe: false });
  for (const t of plan.toBeCreated) if (!missing.includes(t.table)) problems.push(`Better Auth table ${t.table} needs to be created`);
  for (const t of plan.toBeAdded) problems.push(`Better Auth table ${t.table} is missing columns: ${Object.keys(t.fields).join(', ')}`);
  for (const i of plan.toBeAddedIndexes) problems.push(`Better Auth index ${i.name} on ${i.table} is missing`);
  problems.push(...plan.unsafeChanges, ...plan.schemaProblems);
  return problems;
}

async function ensureAuthSchema(dataDir, secret, report) {
  const db = openIdentityDb({ dataDir });
  try {
    const plan = await getMigrations(authOptionsFor(db, secret));
    const pending = [
      ...plan.toBeCreated.map((t) => `create ${t.table}`),
      ...plan.toBeAdded.map((t) => `add columns to ${t.table}`),
      ...plan.toBeAddedIndexes.map((i) => `add index ${i.name}`),
    ];
    if (pending.length) {
      await plan.runMigrations();
      report.created.push(`Better Auth schema (${pending.join(', ')})`);
    } else {
      report.verified.push('Better Auth schema');
    }
  } finally {
    db.close();
  }
}

export async function ensureDatabases({ dataDir, authSecret, now, backupStamp, report }) {
  const paths = layout(dataDir);
  for (const name of DATABASE_NAMES) {
    const file = path.join(paths.db, `${name}.db`);
    if (!lstatOrUndefined(file)) {
      createDatabase(name, { dataDir, now });
      report.created.push(`${name} database`);
      continue;
    }
    try {
      openDatabase(name, { dataDir }).close();
      report.verified.push(`${name} database`);
    } catch (err) {
      if (err.code !== DB_ERROR_CODES.VERSION_OLD) throw err;
      const backup = path.join(paths.backups, backupStamp, `${name}.db`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      await backupDatabase(name, backup, { dataDir });
      const result = migrateDatabase(name, { dataDir, now });
      report.created.push(`${name} database migrated v${result.from} → v${result.to} (backup: ${path.relative(paths.root, backup)})`);
    }
  }
  await ensureAuthSchema(dataDir, authSecret, report);
}

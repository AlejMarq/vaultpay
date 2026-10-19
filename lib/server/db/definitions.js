// VaultPay database definitions – the single source of truth for which SQLite databases
// exist, where they live, which schema version the code expects, and which tables belong
// to another owner (Better Auth). Callers pick a database by name; they never pass a path.

import path from 'node:path';

import { DB_ERROR_CODES as E, DbError } from './errors.js';

// Encoded into each file's header with PRAGMA application_id, so a file that is not a
// VaultPay database of the expected kind is refused before any table is read.
// 'VPID', 'VPTX' and 'VPMB' as 32-bit integers.
const APPLICATION_ID_IDENTITY = 0x56504944;
const APPLICATION_ID_TRANSACTION = 0x56505458;
const APPLICATION_ID_MOCK_CORE_BANKING = 0x56504d42;

// Better Auth creates and owns these tables in the identity database (Step 2, setup).
// The schema check allows them (and their indexes) but never triggers or views on them.
export const BETTER_AUTH_TABLES = Object.freeze(['user', 'session', 'account', 'verification', 'twoFactor']);

export const DATABASES = Object.freeze({
  identity: Object.freeze({
    name: 'identity',
    fileName: 'identity.db',
    applicationId: APPLICATION_ID_IDENTITY,
    schemaVersion: 1,
    externalTables: BETTER_AUTH_TABLES,
  }),
  transaction: Object.freeze({
    name: 'transaction',
    fileName: 'transaction.db',
    applicationId: APPLICATION_ID_TRANSACTION,
    schemaVersion: 1,
    externalTables: Object.freeze([]),
  }),
  // Stands in for the partner Core Banking System (D7: the source of truth for balances).
  // Only the mock Core Banking process opens it; VaultPay services never do.
  'mock-core-banking': Object.freeze({
    name: 'mock-core-banking',
    fileName: 'mock-core-banking.db',
    applicationId: APPLICATION_ID_MOCK_CORE_BANKING,
    schemaVersion: 1,
    externalTables: Object.freeze([]),
  }),
});

export function getDefinition(name) {
  if (typeof name !== 'string' || !Object.hasOwn(DATABASES, name)) {
    throw new DbError(E.UNKNOWN, `unknown database "${String(name)}"`);
  }
  return DATABASES[name];
}

// Paths are resolved from the project root (npm scripts and `next start` both run there).
// Tests pass their own temporary dataDir.
export function defaultDataDir() {
  return path.resolve(process.cwd(), 'data');
}

export function migrationsDir(name) {
  return path.resolve(process.cwd(), 'lib', 'server', 'db', 'migrations', getDefinition(name).name);
}

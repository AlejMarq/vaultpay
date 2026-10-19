// Public entry point for VaultPay database access. Server-side only: this imports
// better-sqlite3 and node:fs, so it must never be imported from a Client Component.

export { DATABASES, BETTER_AUTH_TABLES, defaultDataDir } from './definitions.js';
export { DB_ERROR_CODES, DbError } from './errors.js';
export {
  backupDatabase,
  checkIntegrity,
  createDatabase,
  migrateDatabase,
  openDatabase,
  openIdentityDb,
  openMockCoreBankingDb,
  openTransactionDb,
} from './open.js';

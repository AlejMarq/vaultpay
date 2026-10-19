// Every refusal to create, migrate or open a database is a DbError with a stable code,
// so callers (setup, health checks, tests) can react without parsing messages.

export const DB_ERROR_CODES = Object.freeze({
  UNKNOWN: 'DB_UNKNOWN',                     // no such database definition
  MISSING: 'DB_MISSING',                     // file does not exist (never auto-created)
  EXISTS: 'DB_EXISTS',                       // refusing to create over an existing file
  UNSAFE_PATH: 'DB_UNSAFE_PATH',             // outside data dir, symlink/junction, not a regular file
  NOT_A_DATABASE: 'DB_NOT_A_DATABASE',       // unreadable or not SQLite
  INTEGRITY: 'DB_INTEGRITY',                 // quick_check / integrity_check / foreign_key_check failed
  WRONG_ROLE: 'DB_WRONG_ROLE',               // application_id or db_meta role does not match
  VERSION_OLD: 'DB_VERSION_OLD',             // older schema; run npm run setup
  VERSION_NEW: 'DB_VERSION_NEW',             // newer schema than this code understands
  SCHEMA_MISMATCH: 'DB_SCHEMA_MISMATCH',     // tables/indexes/triggers/views differ from the migrations
  MIGRATION_INVALID: 'DB_MIGRATION_INVALID', // migration files missing, misnamed or edited after applying
  NOT_EMPTY: 'DB_NOT_EMPTY',                 // refusing to initialize a file that already has objects
});

export class DbError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

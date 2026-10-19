// Health check for the Next.js app. Verifies that this process could serve requests:
// its web.env loads, the databases it uses open read-only and pass every safety check,
// and Better Auth starts on the identity DB.
//
// The mock Core Banking database is deliberately not checked: only the mock Core Banking
// process opens it (Next.js reaches Core Banking only through CBI).

import { getWebConfig } from './config.js';
import { defaultDataDir } from './db/definitions.js';
import { openDatabase } from './db/index.js';

export const APP_DATABASES = Object.freeze(['identity', 'transaction']);

/**
 * Returns { ok, problems } where problems are short codes such as
 * "config:CONFIG_MISSING" or "identity:DB_SCHEMA_MISMATCH" – never paths or values.
 */
export async function checkHealth({ dataDir = defaultDataDir(), checkAuth } = {}) {
  const problems = [];
  try {
    getWebConfig({ dataDir });
  } catch (err) {
    problems.push(`config:${err.code ?? 'ERROR'}`);
  }
  for (const name of APP_DATABASES) {
    try {
      openDatabase(name, { dataDir, readonly: true }).close();
    } catch (err) {
      problems.push(`${name}:${err.code ?? 'ERROR'}`);
    }
  }
  if (checkAuth && problems.length === 0) {
    try {
      await checkAuth();
    } catch (err) {
      problems.push(`auth:${err.code ?? 'ERROR'}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

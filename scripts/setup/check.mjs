// Read-only validation of an installation. Used by `npm run setup:check` and as the
// last step of `npm run setup`. Never writes anything.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

import { checkIntegrity, openDatabase } from '../../lib/server/db/index.js';

import { inspectPermissions } from './acl.mjs';
import { DATABASE_NAMES, inspectAuthSchema } from './databases.mjs';
import { DEMO_CUSTOMERS, DEMO_MERCHANTS, DEMO_OPS_USERS } from './demo-data.mjs';
import { assertPlainDirectory, layout } from './paths.mjs';
import { PKI_FILES, verifyPki } from './pki.mjs';
import { readSecret, SECRET_FILES, verifySecrets } from './secrets.mjs';
import { inspectDemoData } from './seed.mjs';

// Generated files that must be git-ignored when data/ is inside the repository.
const IGNORE_SAMPLES = ['db/identity.db', 'db/transaction.db', 'db/mock-core-banking.db', 'secrets/web.env', 'pki/ca.key', 'setup-manifest.json'];

function gitIgnoreProblems(repoRoot, dataRoot) {
  const rel = path.relative(repoRoot, dataRoot);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return []; // data/ outside the repo (tests)
  const problems = [];
  for (const sample of IGNORE_SAMPLES) {
    const p = `${rel.replaceAll('\\', '/')}/${sample}`;
    try {
      execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', '--', p], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      problems.push(err.status === 1 ? `${p} is NOT ignored by git` : `git check-ignore failed (${err.message.split('\n')[0]})`);
    }
  }
  try {
    const tracked = execFileSync('git', ['-C', repoRoot, 'ls-files', '--', rel], { encoding: 'utf8', windowsHide: true }).trim();
    if (tracked) problems.push(`files under ${rel}/ are tracked by git: ${tracked.split('\n').join(', ')}`);
  } catch (err) {
    problems.push(`git ls-files failed (${err.message.split('\n')[0]})`);
  }
  return problems;
}

export async function runChecks({ dataDir, now = Date.now(), repoRoot } = {}) {
  const results = [];
  const add = (area, status, message) => results.push({ area, status, message });
  const paths = layout(dataDir);

  try {
    for (const d of [paths.root, paths.db, paths.pki, paths.secrets]) assertPlainDirectory(d);
    add('directories', 'pass', 'data/, data/db, data/pki and data/secrets are plain directories');
  } catch (err) {
    add('directories', 'fail', err.message);
    return results;
  }

  const acl = inspectPermissions(paths.root);
  if (acl.length) add('permissions', 'warn', `data/ is not restricted to the current user: ${acl.join('; ')}`);
  else add('permissions', 'pass', 'data/ is restricted to the current user');

  const secrets = verifySecrets(paths.secrets);
  if (secrets.problems.length) add('secrets', 'fail', secrets.problems.join('; '));
  else add('secrets', 'pass', `${SECRET_FILES.length} process files; service-token key ${secrets.keyIds.serviceToken}, risk-decision key ${secrets.keyIds.riskDecision}`);

  const pki = verifyPki(paths.pki, { now });
  if (pki.problems.length) add('certificates', 'fail', pki.problems.join('; '));
  else add('certificates', 'pass', `CA + ${Object.keys(pki.certificates).length - 1} service certificates valid; earliest expiry ${Object.values(pki.certificates).map((c) => c.notAfter).sort()[0]}`);
  for (const w of pki.warnings) add('certificates', 'warn', w);

  // Certificate paths named in env files must be files this setup generated.
  if (!secrets.problems.length) {
    const referenced = new Set();
    for (const f of SECRET_FILES) {
      for (const v of Object.values(util.parseEnv(fs.readFileSync(path.join(paths.secrets, f), 'utf8')))) {
        if (v.startsWith('pki/')) referenced.add(v.slice(4));
      }
    }
    const dangling = [...referenced].filter((f) => !PKI_FILES.includes(f) || !fs.existsSync(path.join(paths.pki, f)));
    if (dangling.length) add('secrets', 'fail', `env files reference missing certificate files: ${dangling.join(', ')}`);
  }

  for (const name of DATABASE_NAMES) {
    let db;
    try {
      db = openDatabase(name, { dataDir, readonly: true });
      checkIntegrity(db);
      const meta = db.prepare('SELECT schema_version FROM db_meta').get();
      add(`${name} db`, 'pass', `opens read-only, integrity ok, schema v${meta.schema_version}`);
      if (name === 'identity') {
        if (secrets.problems.length) {
          add('better auth', 'fail', 'cannot check Better Auth tables without a valid web.env');
        } else {
          const problems = await inspectAuthSchema(db, readSecret(paths.secrets, 'web', 'BETTER_AUTH_SECRET'));
          if (problems.length) add('better auth', 'fail', problems.join('; '));
          else add('better auth', 'pass', 'all 5 Better Auth tables present and up to date');
        }
      }
    } catch (err) {
      add(`${name} db`, 'fail', `${err.code ?? 'ERROR'}: ${err.message}`);
    } finally {
      db?.close();
    }
  }

  // Cross-database checks, only once every database itself is sound.
  if (!results.some((r) => r.status === 'fail' && r.area.endsWith(' db'))) {
    const identity = openDatabase('identity', { dataDir, readonly: true });
    const bank = openDatabase('mock-core-banking', { dataDir, readonly: true });
    try {
      const refs = identity.prepare('SELECT core_account_ref AS ref FROM wallet UNION ALL SELECT core_account_ref FROM merchant').all().map((r) => r.ref);
      const unmapped = refs.filter((ref) => !bank.prepare('SELECT 1 FROM account WHERE account_ref = ?').get(ref));
      if (unmapped.length) add('accounts', 'fail', `wallets/merchants without a mock Core Banking account: ${unmapped.join(', ')}`);
      else add('accounts', 'pass', `all ${refs.length} wallet and merchant accounts exist at mock Core Banking`);

      const demo = inspectDemoData(identity, bank);
      if (demo.length) add('demo data', 'fail', demo.join('; '));
      else add('demo data', 'pass', `${DEMO_CUSTOMERS.length} demo customers, ${DEMO_OPS_USERS.length} ops user, ${DEMO_MERCHANTS.length} merchant (localhost demo only)`);
    } finally {
      bank.close();
      identity.close();
    }
  }

  if (repoRoot) {
    const problems = gitIgnoreProblems(repoRoot, paths.root);
    if (problems.length) add('git', 'fail', problems.join('; '));
    else add('git', 'pass', 'generated files are git-ignored and none are tracked');
  }
  return results;
}

export const hasFailures = (results) => results.some((r) => r.status === 'fail');

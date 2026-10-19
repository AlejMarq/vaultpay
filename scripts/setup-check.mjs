// npm run setup:check – read-only validation of this computer's VaultPay installation.
// Exit code 0: no failures (warnings allowed). Exit code 1: at least one failure.

import fs from 'node:fs';
import path from 'node:path';

import { hasFailures, runChecks } from './setup/check.mjs';
import { printChecks, requireProjectRoot } from './setup/cli.mjs';

const root = requireProjectRoot();
const dataDir = path.join(root, 'data');

if (!fs.existsSync(dataDir)) {
  console.error('No data/ directory – run npm run setup first.');
  process.exit(1);
}

const checks = await runChecks({ dataDir, repoRoot: fs.existsSync(path.join(root, '.git')) ? root : undefined });
printChecks(checks);
const failed = hasFailures(checks);
console.log(failed ? '\nINSTALLATION CHECK FAILED' : '\nInstallation check passed');
process.exit(failed ? 1 : 0);

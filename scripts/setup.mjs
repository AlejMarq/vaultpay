// npm run setup – prepares (or verifies) a VaultPay installation on this computer.
//
//   npm run setup                    create anything missing; verify and keep everything else
//   npm run setup -- --reset-db      back up, then recreate both databases (typed confirmation)
//   npm run setup -- --rotate-secrets
//   npm run setup -- --renew-certs
//
// Everything generated goes under data/ (git-ignored). Secrets are never printed.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { RESETS, runSetup } from './setup/run.mjs';
import { printChecks, requireProjectRoot } from './setup/cli.mjs';

const args = process.argv.slice(2);
const flags = new Map(Object.entries(RESETS).map(([kind, r]) => [r.flag, kind]));
const unknown = args.filter((a) => !flags.has(a));
if (unknown.length) {
  console.error(`Unknown option(s): ${unknown.join(' ')}\nAllowed: ${[...flags.keys()].join(', ')}`);
  process.exit(2);
}
const reset = Object.fromEntries(args.map((a) => [flags.get(a), true]));

// Destructive options need a person at the keyboard typing the confirmation word.
async function confirm({ flag, word, description }) {
  console.log(`\n${flag}: ${description}`);
  if (!process.stdin.isTTY) {
    console.log('No interactive terminal – refusing without confirmation.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`Type ${word} to continue, anything else to cancel: `)).trim() === word;
  } finally {
    rl.close();
  }
}

const root = requireProjectRoot();
console.log(`VaultPay setup – Node ${process.versions.node}, data directory ${path.join(root, 'data')}`);

try {
  const report = await runSetup({ dataDir: path.join(root, 'data'), reset, confirm, repoRoot: fs.existsSync(path.join(root, '.git')) ? root : undefined });
  for (const item of report.archived) console.log(`  MOVED     ${item}`);
  for (const item of report.created) console.log(`  CREATED   ${item}`);
  for (const item of report.verified) console.log(`  KEPT      ${item} (verified, unchanged)`);
  for (const w of report.warnings) console.log(`  WARN      ${w}`);
  console.log('\nInstallation check:');
  printChecks(report.checks);
  console.log('\nSetup complete.');
} catch (err) {
  if (err.checks) printChecks(err.checks);
  console.error(`\nSETUP FAILED: ${err.message}`);
  process.exit(1);
}

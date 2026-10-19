// Shared command-line helpers for setup and setup:check.

import fs from 'node:fs';
import path from 'node:path';

export const REQUIRED_NODE_MAJOR = 22;

// Both commands must run from the VaultPay project root on Node 22 (D13).
export function requireProjectRoot() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== REQUIRED_NODE_MAJOR) {
    console.error(`VaultPay requires Node.js ${REQUIRED_NODE_MAJOR} (found ${process.versions.node}). See .nvmrc.`);
    process.exit(1);
  }
  const root = process.cwd();
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    pkg = undefined;
  }
  if (pkg?.name !== 'vaultpay') {
    console.error('Run this from the VaultPay project root (use npm run setup / npm run setup:check).');
    process.exit(1);
  }
  return root;
}

export function printChecks(checks) {
  for (const c of checks) console.log(`  ${c.status.toUpperCase().padEnd(5)} ${c.area.padEnd(13)} ${c.message}`);
}

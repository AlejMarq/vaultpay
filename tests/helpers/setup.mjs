// Helpers for setup tests: run the real setup against a temporary data directory.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { runSetup } from '../../scripts/setup/run.mjs';
import { tempDataDir } from './db.mjs';

export async function freshInstall(t, options = {}) {
  const dataDir = tempDataDir(t);
  const report = await runSetup({ dataDir, ...options });
  return { dataDir, report };
}

// SQLite's WAL and shared-memory side files are runtime state, recreated by any
// connection (even read-only); they hold no generated data and are left out.
const SQLITE_RUNTIME_FILE = /\.db-(wal|shm)$/;

// Every generated file under dir → { relativePath: { sha256, mtimeMs } }.
export function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (SQLITE_RUNTIME_FILE.test(entry.name)) continue;
      if (entry.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = { sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), mtimeMs: fs.statSync(p).mtimeMs };
    }
  };
  walk(dir);
  return out;
}

export const readEnv = (dataDir, proc) => fs.readFileSync(path.join(dataDir, 'secrets', `${proc}.env`), 'utf8');
export const writeEnv = (dataDir, proc, text) => fs.writeFileSync(path.join(dataDir, 'secrets', `${proc}.env`), text);
export const pkiFile = (dataDir, file) => path.join(dataDir, 'pki', file);

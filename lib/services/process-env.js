// Loads one backend process's own configuration: data/secrets/<process>.env and the TLS
// files it names (Step 4). Mirrors lib/server/config.js (the Next.js "web" loader):
//   - only plain directories and regular files (no links or junctions)
//   - VAULTPAY_PROCESS must name this process – a process never loads another's file
//   - certificate paths must stay inside data/pki
//   - values are returned frozen and never copied into process.env
//   - errors name the problem, never a value

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

import { defaultDataDir } from '../server/db/definitions.js';

export class ProcessConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProcessConfigError';
    this.code = code;
  }
}

function plain(p, kind) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') throw new ProcessConfigError('CONFIG_MISSING', `${p} is missing – run npm run setup`);
    throw new ProcessConfigError('CONFIG_UNREADABLE', `cannot inspect ${p} (${err.code})`);
  }
  const ok = kind === 'dir' ? st.isDirectory() : st.isFile();
  if (st.isSymbolicLink() || !ok) throw new ProcessConfigError('CONFIG_UNSAFE', `not a plain ${kind === 'dir' ? 'directory' : 'file'}: ${p}`);
}

const TLS_PATH = /^pki\/[a-z-]+\.(crt|key)$/;

/**
 * Returns { values, tls: { cert, key, ca } } for `processName` (e.g. 'cbi',
 * 'mock-core-banking'). `required` lists keys that must be present and non-empty.
 */
export function loadProcessEnv(processName, { dataDir = defaultDataDir(), required = [] } = {}) {
  const root = path.resolve(/* turbopackIgnore: true */ dataDir);
  for (const d of [root, path.join(/* turbopackIgnore: true */ root, 'secrets'), path.join(/* turbopackIgnore: true */ root, 'pki')]) plain(d, 'dir');
  const file = path.join(/* turbopackIgnore: true */ root, 'secrets', `${processName}.env`);
  plain(file, 'file');

  let values;
  try {
    values = util.parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ProcessConfigError('CONFIG_UNREADABLE', `cannot read ${processName}.env (${err.code ?? 'parse error'})`);
  }
  if (values.VAULTPAY_PROCESS !== processName) throw new ProcessConfigError('CONFIG_INVALID', `${processName}.env belongs to a different process`);
  const missing = ['TLS_CERT', 'TLS_KEY', 'TLS_CA', ...required].filter((k) => typeof values[k] !== 'string' || values[k] === '');
  if (missing.length) throw new ProcessConfigError('CONFIG_INVALID', `${processName}.env is missing ${missing.join(', ')} – run npm run setup:check`);

  const readTls = (key) => {
    if (!TLS_PATH.test(values[key])) throw new ProcessConfigError('CONFIG_INVALID', `${processName}.env: ${key} must point inside data/pki`);
    const p = path.join(/* turbopackIgnore: true */ root, ...values[key].split('/'));
    plain(p, 'file');
    return fs.readFileSync(p);
  };
  const tls = Object.freeze({ cert: readTls('TLS_CERT'), key: readTls('TLS_KEY'), ca: readTls('TLS_CA') });
  return Object.freeze({ values: Object.freeze({ ...values }), tls });
}

export function requireNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22) {
    console.error(`VaultPay services require Node.js 22 (found ${process.versions.node}). See .nvmrc.`);
    process.exit(1);
  }
}

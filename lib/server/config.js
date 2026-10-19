// Loads the Next.js ("web") process configuration from data/secrets/web.env.
//
// Next.js only loads .env files from the project root, so this file is read explicitly.
// Values are kept in a frozen object and never copied into process.env, so they are not
// inherited by child processes. Errors name the problem, never a value.

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

import { defaultDataDir } from './db/definitions.js';

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

// Settings the web process needs. Others in web.env (e.g. the service-token signing key)
// are used in later steps and are loaded on demand from the same frozen object.
const REQUIRED = ['VAULTPAY_PROCESS', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'SERVICE_TOKEN_SIGNING_KEY', 'SERVICE_TOKEN_KEY_ID'];
const ALLOWED_AUTH_URLS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

function lstatOrUndefined(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw new ConfigError('CONFIG_UNREADABLE', `cannot inspect ${p} (${err.code})`);
  }
}

/** Reads and validates web.env. Throws ConfigError; never returns partial config. */
export function loadWebConfig({ dataDir = defaultDataDir() } = {}) {
  // turbopackIgnore: data/ is runtime state, not code – never trace it into build output
  const root = path.resolve(/* turbopackIgnore: true */ dataDir);
  const dir = path.join(/* turbopackIgnore: true */ root, 'secrets');
  const file = path.join(/* turbopackIgnore: true */ dir, 'web.env');

  for (const p of [root, dir]) {
    const st = lstatOrUndefined(p);
    if (!st) throw new ConfigError('CONFIG_MISSING', 'VaultPay is not set up on this computer – run npm run setup');
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ConfigError('CONFIG_UNSAFE', `not a plain directory: ${p}`);
  }
  const st = lstatOrUndefined(file);
  if (!st) throw new ConfigError('CONFIG_MISSING', 'data/secrets/web.env is missing – run npm run setup');
  if (st.isSymbolicLink() || !st.isFile()) throw new ConfigError('CONFIG_UNSAFE', `not a regular file: ${file}`);

  let values;
  try {
    values = util.parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError('CONFIG_UNREADABLE', `cannot read web.env (${err.code ?? 'parse error'})`);
  }

  const missing = REQUIRED.filter((k) => typeof values[k] !== 'string' || values[k] === '');
  if (missing.length) throw new ConfigError('CONFIG_INVALID', `web.env is missing ${missing.join(', ')} – run npm run setup:check`);
  if (values.VAULTPAY_PROCESS !== 'web') throw new ConfigError('CONFIG_INVALID', 'web.env belongs to a different process');
  if (Buffer.from(values.BETTER_AUTH_SECRET, 'base64url').length < 32) throw new ConfigError('CONFIG_INVALID', 'BETTER_AUTH_SECRET is too short');
  if (!ALLOWED_AUTH_URLS.includes(values.BETTER_AUTH_URL)) throw new ConfigError('CONFIG_INVALID', 'BETTER_AUTH_URL must be a localhost address');

  return Object.freeze({ ...values, dataDir: root });
}

// One cached copy per process (per data directory).
const cache = new Map();

export function getWebConfig({ dataDir = defaultDataDir() } = {}) {
  const key = path.resolve(/* turbopackIgnore: true */ dataDir);
  if (!cache.has(key)) cache.set(key, loadWebConfig({ dataDir: key }));
  return cache.get(key);
}

export const TRUSTED_ORIGINS = Object.freeze([...ALLOWED_AUTH_URLS]);

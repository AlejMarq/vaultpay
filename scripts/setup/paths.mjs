// Locations of everything `npm run setup` generates. All of it lives under data/,
// which is git-ignored. Paths written into env files are relative to data/.

import fs from 'node:fs';
import path from 'node:path';

export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

export function layout(dataDir) {
  const root = path.resolve(dataDir);
  return {
    root,
    db: path.join(root, 'db'),
    pki: path.join(root, 'pki'),
    secrets: path.join(root, 'secrets'),
    backups: path.join(root, 'backups'),
    manifest: path.join(root, 'setup-manifest.json'),
    lock: path.join(root, '.setup.lock'),
  };
}

export function lstatOrUndefined(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

// A directory we generate into must be a real directory, never a symlink or junction.
export function assertPlainDirectory(p) {
  const st = lstatOrUndefined(p);
  if (!st) throw new SetupError(`directory does not exist: ${p}`);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SetupError(`not a plain directory (link or file): ${p}`);
}

export function ensurePlainDirectory(p) {
  if (!lstatOrUndefined(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  assertPlainDirectory(p);
}

// Writes a new file; refuses to replace an existing one.
export function writeNewFile(file, content) {
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
}

// Lists a generated directory: 'absent', 'empty', or the sorted file names in it.
export function directoryState(dir) {
  const st = lstatOrUndefined(dir);
  if (!st) return { state: 'absent', files: [] };
  assertPlainDirectory(dir);
  const files = fs.readdirSync(dir).sort();
  return { state: files.length === 0 ? 'empty' : 'present', files };
}

// Builds a directory's contents under a temporary sibling name, then renames it into
// place, so a generated set (all secrets, or all certificates) appears all at once or
// not at all. Refuses if the target exists.
export async function buildDirectoryAtomically(target, build) {
  if (lstatOrUndefined(target)) throw new SetupError(`refusing to replace existing ${target}`);
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    await build(staging);
    fs.renameSync(staging, target);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

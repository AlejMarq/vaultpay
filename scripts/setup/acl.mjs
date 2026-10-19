// Best-effort file permissions for data/ (approved decision 7).
//
// Windows: icacls removes inherited permissions from data/ and grants full control to the
// current user only; files created inside inherit that. Other systems: chmod 700.
// Failures are reported to the caller, never swallowed. This limits casual access by other
// local accounts; it is not protection against an administrator or malware running as you.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// Principals that must not have access to data/ on Windows.
const BROAD_PRINCIPALS = /\b(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users|NT AUTHORITY\\INTERACTIVE|BUILTIN\\Guests)\b/i;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function currentWindowsUser() {
  return run('whoami', []).trim();
}

/** Lists problems with the current permissions of `dir` (empty array = OK). */
export function inspectPermissions(dir) {
  try {
    if (process.platform !== 'win32') {
      const mode = fs.statSync(dir).mode & 0o777;
      return mode & 0o077 ? [`${dir} is accessible to other users (mode ${mode.toString(8)})`] : [];
    }
    const user = currentWindowsUser();
    const output = run('icacls', [dir]);
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const problems = [];
    for (const line of lines) {
      if (BROAD_PRINCIPALS.test(line)) problems.push(`broad access entry: ${line.replace(dir, '').trim()}`);
    }
    if (!output.toLowerCase().includes(user.toLowerCase())) problems.push(`current user ${user} has no explicit entry`);
    if (/\(I\)/.test(output)) problems.push('still inherits permissions from a parent folder');
    return problems;
  } catch (err) {
    return [`could not read permissions (${err.message.split('\n')[0]})`];
  }
}

/**
 * Restricts `dir` to the current user. Returns { ok, problems }; the caller reports
 * problems as warnings. Safe to run repeatedly.
 */
export function protectDirectory(dir) {
  try {
    if (process.platform === 'win32') {
      const user = currentWindowsUser();
      run('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/Q']);
      // Remove any explicit broad grants that existed before.
      for (const principal of ['*S-1-1-0', '*S-1-5-32-545', '*S-1-5-11', '*S-1-5-4']) {
        run('icacls', [dir, '/remove:g', principal, '/Q']);
      }
    } else {
      fs.chmodSync(dir, 0o700);
    }
  } catch (err) {
    return { ok: false, problems: [`could not restrict permissions on ${dir} (${err.message.split('\n')[0]})`] };
  }
  const problems = inspectPermissions(dir);
  return { ok: problems.length === 0, problems };
}

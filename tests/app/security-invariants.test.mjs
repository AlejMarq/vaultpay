// Static checks that keep Step 3's security rules from silently regressing when new code
// is added: every Server Action validates Origin (and localhost Host) first, every page
// runs a server-side guard, and the proxy grants nothing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const files = (dir, name) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? files(p, name) : name.test(e.name) ? [p] : [];
});
const rel = (p) => p.replaceAll('\\', '/');

test('every Server Action checks Origin and Host before doing anything else', () => {
  const modules = files('app', /\.js$/).filter((f) => /^'use server'/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(modules.length >= 4, `found ${modules.length} Server Action modules`);
  const unchecked = [];
  for (const file of modules) {
    const src = fs.readFileSync(file, 'utf8');
    const actions = [...src.matchAll(/export async function (\w+)\([^)]*\) \{\n([\s\S]*?)\n\}/g)];
    assert.ok(actions.length > 0, `${rel(file)} exports actions`);
    for (const [, name, body] of actions) {
      // The first statement must be the check (directly or via the request headers).
      const first = body.trim().split('\n').slice(0, 2).join('\n');
      if (!/assertSameOrigin\(/.test(first)) unchecked.push(`${rel(file)}#${name}`);
    }
    assert.doesNotMatch(src, /export (const|let|function) /, `${rel(file)}: only async function exports`);
  }
  assert.deepEqual(unchecked, []);
});

test('every page runs a server-side guard (except the static access-denied page)', () => {
  const required = {
    'app/wallet/page.js': 'requireCustomer',
    'app/send/page.js': 'requireCustomer',
    'app/support/page.js': 'requireSupport',
    'app/operations/page.js': 'requireSupport',
    'app/dashboard/page.js': 'requireMfaVerifiedViewer',
    'app/mfa/page.js': 'requireViewer',
    'app/mfa/setup/page.js': 'requireViewer',
    'app/mfa/verify/page.js': 'getViewer',
    'app/login/page.js': 'getViewer',
    'app/page.js': 'getViewer',
  };
  const pages = files('app', /^page\.js$/).map(rel).sort();
  assert.deepEqual(pages, [...Object.keys(required), 'app/access-denied/page.js'].sort(), 'a new page needs a guard entry here');
  for (const [page, guard] of Object.entries(required)) {
    assert.match(fs.readFileSync(page, 'utf8'), new RegExp(`\\b${guard}\\(`), `${page} calls ${guard}()`);
  }
  assert.doesNotMatch(fs.readFileSync('app/access-denied/page.js', 'utf8'), /lib\/server/, 'access-denied page reads no server data');
});

test('no Better Auth HTTP routes are mounted', () => {
  const handlers = files('app', /^route\.js$/).map(rel);
  assert.deepEqual(handlers, ['app/api/health/route.js']);
  for (const f of files('app', /\.js$/)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /toNextJsHandler/, rel(f));
});

test('the proxy only redirects – it never reads data or grants access', () => {
  const src = fs.readFileSync('proxy.js', 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['next/server'], 'no data, database or Better Auth access');
  assert.doesNotMatch(src, /NextResponse\.rewrite|headers\.set|cookies\.set/);
  assert.match(src, /NextResponse\.redirect\(new URL\('\/login'/);
});

test('Step 5: only the audit writer and the transfer writer open writable transaction DB connections; nothing settles', () => {
  const sources = [...files('app', /\.js$/), ...files(path.join('lib', 'server'), /\.js$/)].map((f) => [rel(f), fs.readFileSync(f, 'utf8')]);
  const writable = sources.filter(([, src]) => /openTransactionDb\(\{(?![^}]*readonly: true)/.test(src)).map(([f]) => f).sort();
  assert.deepEqual(writable, ['lib/server/audit.js', 'lib/server/transfer-orchestrator.js']);
  for (const [f, src] of sources) {
    assert.doesNotMatch(src, /UPDATE\s+transfer\b|INSERT\s+INTO\s+(ledger_entry|settlement_attempt|risk_decision)\b/i, `${f}: no status change, posting or decision in Step 5`);
    // config.js names them only to refuse them; db/ is the shared database layer (definitions).
    if (f === 'lib/server/config.js' || f.startsWith('lib/server/db/')) continue;
    assert.doesNotMatch(src, /openMockCoreBankingDb|mock-core-banking\.db|SERVICE_TOKEN_SIGNING_KEY|MOCK_CORE_BANKING_API_KEY/, `${f}: no bank database, signing key or bank credential in Next.js`);
  }
});

test('Steps 6–7: Next.js never imports the fraud signer, an outbox worker or a service process', () => {
  for (const f of [...files('app', /\.js$/), ...files(path.join('lib', 'server'), /\.js$/)]) {
    const src = fs.readFileSync(f, 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports.filter((i) => /(^|\/)(fraud|orchestrator)\/|(^|\.\.\/)services\/(fraud|settlement|identity|cbi|mock-core-banking|orchestrator|common)\//.test(i)), [], rel(f));
    assert.doesNotMatch(src, /RISK_DECISION_PUBLIC_KEY/, `${rel(f)}: no risk-decision key in Next.js`);
  }
});

test('Step 8: the operations page is read-only – no Server Action, no form besides sign-out, no writer', () => {
  const src = fs.readFileSync('app/operations/page.js', 'utf8');
  assert.doesNotMatch(src, /'use server'|<form|action=|formAction|transferWriter|createReconciler|openTransactionDb\(/);
  assert.deepEqual(files(path.join('app', 'operations'), /\.js$/).map(rel), ['app/operations/page.js']);
  const ops = fs.readFileSync('lib/server/operations.js', 'utf8');
  assert.doesNotMatch(ops, /(INSERT|UPDATE|DELETE)/, 'the overview has no write statement (the audit writer records the view)');
});

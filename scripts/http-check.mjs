// npm run test:http – checks the BUILT app over real HTTP (run `npm run build` first).
//
// Creates a temporary installation (never touches this computer's data/), starts
// `next start` with exactly the arguments of the package.json "start" script plus a spare
// port and VAULTPAY_DATA_DIR, then checks:
//   - build output tracing lists no runtime data (databases, keys, secrets)  [regression]
//   - the server only listens on 127.0.0.1; http://localhost still works
//   - /api/health and the security headers
//   - login / logout / sessions through real Server Action form POSTs (the same requests a
//     browser sends without JavaScript), including foreign-Origin and missing-Origin POSTs
//   - protected pages deny password-only sessions (MFA not completed)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { totp } from '../tests/helpers/totp.mjs';

import { startAllServices } from './lib/spawn-service.mjs';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from './setup/demo-data.mjs';
import { runSetup } from './setup/run.mjs';

const PORT = 3999;
const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [alice, bob, carol] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;
const extraConnections = []; // closed in `finally`, so the temporary install can be deleted
const GENERIC = 'Incorrect email or password.';
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? ` -> ${detail}` : ''}`);
  if (!ok) failures += 1;
}

if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) {
  console.error('No production build found – run npm run build first.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build output tracing must never list runtime data (databases, keys, secrets) as server
// dependencies – a standalone or deployment build would copy them.  [regression test]
console.log('\nBuild output tracing');
const traces = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p);
  else if (e.name.endsWith('.nft.json')) traces.push(p);
});
walk(path.join(root, '.next'));
const leaked = traces.flatMap((t) => JSON.parse(fs.readFileSync(t, 'utf8')).files
  .map((f) => path.resolve(path.dirname(t), f))
  .filter((f) => f.startsWith(path.join(root, 'data') + path.sep) || /\.(env|key|crt|pem|db)$/.test(f)));
check(`no data/ or secret files in ${traces.length} trace manifests`, leaked.length === 0, [...new Set(leaked)].slice(0, 5).join(', '));

// "next start --hostname 127.0.0.1" → ["start", "--hostname", "127.0.0.1"]
const [bin, ...startArgs] = pkg.scripts.start.split(/\s+/);
if (bin !== 'next') throw new Error(`unexpected start script: ${pkg.scripts.start}`);
check('start script binds to 127.0.0.1', /--hostname 127\.0\.0\.1\b/.test(pkg.scripts.start), pkg.scripts.start);
check('dev script binds to 127.0.0.1', /--hostname 127\.0\.0\.1\b/.test(pkg.scripts.dev), pkg.scripts.dev);

// ---------------------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpay-http-'));
console.log('\nTemporary installation');
await runSetup({ dataDir });
check('setup created a temporary installation', fs.existsSync(path.join(dataDir, 'db', 'identity.db')));
const identity = new Database(path.join(dataDir, 'db', 'identity.db'), { readonly: true, fileMustExist: true });
const sessionCount = () => identity.prepare('SELECT count(*) AS n FROM session').get().n;

// Backend services as real processes (mock Core Banking → Identity → CBI), on free ports.
const services = await startAllServices({ dataDir, root });
check('mock Core Banking, Identity and CBI started as separate processes', Object.values(services.addresses).every((a) => a.address === '127.0.0.1'));

const server = spawn(process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), ...startArgs, '--port', String(PORT)], {
  cwd: root,
  env: { ...process.env, VAULTPAY_DATA_DIR: dataDir, VAULTPAY_IDENTITY_PORT: String(services.ports.identity), VAULTPAY_CBI_PORT: String(services.ports.cbi) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
server.stdout.on('data', (d) => { output += d; });
server.stderr.on('data', (d) => { output += d; });
const exited = new Promise((resolve) => server.on('exit', resolve));

const base = `http://127.0.0.1:${PORT}`;
const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      return await fetch(`${base}/api/health`);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`server did not start:\n${output}`);
}

function tryConnect(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: PORT, timeout: 1500 });
    socket.on('connect', () => { socket.destroy(); resolve('connected'); });
    socket.on('timeout', () => { socket.destroy(); resolve('timeout'); });
    socket.on('error', (err) => resolve(err.code));
  });
}

// Builds the multipart body a browser submits for the n-th <form> on a page: its hidden
// Server Action fields ($ACTION_REF_*, $ACTION_*:*, $ACTION_KEY …) plus `fields`.
// `which`: the form's position on the page, or a string the form must contain.
function formFrom(html, fields = {}, which = 0) {
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
  const form = typeof which === 'string' ? forms.find((f) => f.includes(which)) : forms[which];
  if (!form) throw new Error(`no form ${JSON.stringify(which)} on page`);
  const data = new FormData();
  for (const [tag] of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = tag.match(/name="([^"]*)"/)[1];
    const value = (tag.match(/value="([^"]*)"/)?.[1] ?? '').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    data.append(name, value);
  }
  for (const [k, v] of Object.entries(fields)) data.set(k, v); // overrides a hidden field of the same name
  return data;
}

// The state a Server Action returned (useActionState). After a no-JavaScript form POST,
// Next delivers it in the Flight data (`self.__next_f.push([2, [state, …]])`); React
// applies it when the page hydrates, so the server-rendered HTML may still show the
// previous step. Checks read the returned state from here.
function actionState(html) {
  const m = html.match(/self\.__next_f\.push\(\[2,(\[[\s\S]*?\])\]\)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1])[0];
  } catch {
    return null;
  }
}

const post = (p, body, { origin = base, cookie } = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  body,
  redirect: 'manual',
  headers: { ...(origin === null ? {} : { origin }), ...(cookie ? { cookie } : {}) },
});

// Where a GET redirects to. The proxy answers with a real 307. A redirect() inside a page
// arrives after Next has streamed the static shell (Cache Components), so a full page
// load gets 200 plus Next's in-page "NEXT_REDIRECT;replace;<path>;307" instruction, which
// the browser follows. Either way the protected content must be absent.
async function redirectOf(res) {
  if (res.status >= 300 && res.status < 400) return { to: new URL(res.headers.get('location'), base).pathname, html: '' };
  const html = await res.text();
  return { to: html.match(/NEXT_REDIRECT;(?:replace|push);([^;"\\]+);/)?.[1] ?? null, html };
}

async function expectRedirect(name, res, to, mustNotContain = []) {
  const r = await redirectOf(res);
  const leaked = mustNotContain.filter((s) => r.html.includes(s));
  check(name, r.to === to && leaked.length === 0, `status ${res.status}, redirect ${r.to}${leaked.length ? `, leaked: ${leaked.join(', ')}` : ''}`);
}

// Text that only appears when signed-in content is rendered.
const PROTECTED_TEXT = ['Signed in as', 'Welcome,', 'Session expires', 'wal_demo', 'Recent transfers', 'Look up customer'];

// A minimal browser cookie jar: applies Set-Cookie (Max-Age=0 / past Expires deletes).
function cookieJar() {
  const cookies = new Map();
  return {
    apply(res) {
      for (const sc of res.headers.getSetCookie()) {
        const [pair, ...attrs] = sc.split(';').map((s) => s.trim());
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq);
        const gone = attrs.some((a) => /^max-age=0$/i.test(a) || /^expires=.*1970/i.test(a));
        if (gone) cookies.delete(name);
        else cookies.set(name, pair.slice(eq + 1));
      }
      return res;
    },
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    has: (name) => cookies.has(name),
  };
}

const sessionSetCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token='));
const cookiePair = (setCookie) => setCookie.split(';')[0];

async function loginAs(user, password = user.password, opts) {
  const page = await (await get('/login')).text();
  return post('/login', formFrom(page, { email: user.email, password }), opts);
}

try {
  console.log(`\nStarting: next ${startArgs.join(' ')} --port ${PORT} (VAULTPAY_DATA_DIR=<temporary>)`);
  const health = await waitForServer();
  const body = await health.text();

  console.log('\n/api/health');
  check('status 200', health.status === 200, String(health.status));
  check('body is exactly {"status":"ok"}', body === '{"status":"ok"}', body);
  check('Cache-Control: no-store', (health.headers.get('cache-control') ?? '').includes('no-store'), health.headers.get('cache-control'));

  console.log('\nSecurity headers');
  const expected = {
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
  for (const url of ['/login', '/api/health']) {
    const res = url === '/api/health' ? health : await get(url);
    for (const [name, value] of Object.entries(expected)) check(`${url} ${name}`, res.headers.get(name) === value, res.headers.get(name));
    check(`${url} permissions-policy present`, Boolean(res.headers.get('permissions-policy')));
    check(`${url} no X-Powered-By`, !res.headers.has('x-powered-by'), res.headers.get('x-powered-by'));
  }

  console.log('\nLocalhost-only binding');
  const networkLine = output.match(/Network:\s*(\S+)/);
  check('server log shows only a loopback address', !networkLine || /^http:\/\/127\.0\.0\.1:/.test(networkLine[1]), networkLine?.[0]);
  const viaLocalhost = await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.status, (err) => err.cause?.code ?? err.message);
  check(`http://localhost:${PORT} reaches the server`, viaLocalhost === 200, String(viaLocalhost));
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  if (lan.length === 0) console.log('  SKIP  no LAN IPv4 address on this computer');
  for (const address of lan) {
    const result = await tryConnect(address);
    check(`not reachable on ${address}:${PORT}`, result !== 'connected', result);
  }

  // -------------------------------------------------------------------------
  console.log('\nNo public Better Auth routes (authentication runs only through Server Actions)');
  for (const p of ['/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/auth/get-session', '/api/auth/two-factor/enable', '/api/auth/update-user']) {
    const res = await fetch(`${base}${p}`, {
      method: p.endsWith('get-session') ? 'GET' : 'POST',
      redirect: 'manual',
      headers: { origin: base, 'content-type': 'application/json' },
      body: p.endsWith('get-session') ? undefined : JSON.stringify({ email: 'new@example.test', password: 'Some-Password-1!', name: 'New' }),
    });
    check(`${p} → 404`, res.status === 404, String(res.status));
  }
  check('no account was registered', identity.prepare("SELECT count(*) AS n FROM \"user\" WHERE email = 'new@example.test'").get().n === 0);

  console.log('\nSigned out');
  for (const p of ['/dashboard', '/mfa']) {
    const res = await get(p);
    check(`${p} without a cookie redirects to /login`, res.status === 307 && res.headers.get('location')?.endsWith('/login'), `${res.status} ${res.headers.get('location')}`);
  }
  await expectRedirect('/mfa with a forged cookie redirects to /login, nothing rendered (page-level DAL check)',
    await get('/mfa', 'better-auth.session_token=forged.token'), '/login', PROTECTED_TEXT);

  console.log('\nLogin – credential errors (real Server Action POSTs)');
  const wrong = await loginAs(alice, 'wrong-password');
  const wrongHtml = await wrong.text();
  const unknown = await loginAs({ email: 'nobody@example.test' }, alice.password);
  const unknownHtml = await unknown.text();
  check('wrong password: action returns the generic error', wrong.status === 200 && actionState(wrongHtml)?.error === GENERIC, JSON.stringify(actionState(wrongHtml)));
  check('unknown email: action returns the same generic error', unknown.status === 200 && actionState(unknownHtml)?.error === GENERIC, JSON.stringify(actionState(unknownHtml)));
  check('neither sets a session cookie', !sessionSetCookie(wrong) && !sessionSetCookie(unknown));
  check('no session rows created', sessionCount() === 0, String(sessionCount()));

  console.log('\nLogin – Origin enforcement');
  const foreign = await loginAs(alice, alice.password, { origin: 'http://evil.example' });
  check('foreign Origin: rejected', foreign.status >= 400, String(foreign.status));
  check('foreign Origin: no session cookie, no session row', !sessionSetCookie(foreign) && sessionCount() === 0, `${sessionSetCookie(foreign)} / ${sessionCount()}`);
  const noOrigin = await loginAs(alice, alice.password, { origin: null });
  check('missing Origin: rejected', noOrigin.status >= 400, String(noOrigin.status));
  check('missing Origin: no session cookie, no session row', !sessionSetCookie(noOrigin) && sessionCount() === 0, `${sessionSetCookie(noOrigin)} / ${sessionCount()}`);

  console.log('\nLogin – success');
  const ok = await loginAs(alice);
  const issued = sessionSetCookie(ok);
  check('303 redirect to /mfa', ok.status === 303 && ok.headers.get('location') === '/mfa', `${ok.status} ${ok.headers.get('location')}`);
  check('session cookie issued by the Server Action', Boolean(issued), ok.headers.getSetCookie().join(' | '));
  for (const attr of ['HttpOnly', 'Path=/', 'Max-Age=1800']) check(`cookie has ${attr}`, issued?.includes(attr), issued);
  check('cookie has SameSite=Lax', /SameSite=lax/i.test(issued ?? ''), issued);
  check('cookie is host-only (no Domain)', !/Domain=/i.test(issued ?? ''), issued);
  check('one session row', sessionCount() === 1, String(sessionCount()));
  const cookie = cookiePair(issued);

  console.log('\nSigned in, MFA not completed');
  const mfaPage = await get('/mfa', cookie);
  const mfaHtml = await mfaPage.text();
  check('/mfa shows who is signed in', mfaPage.status === 200 && mfaHtml.includes('Alice Demo') && mfaHtml.includes(alice.email), String(mfaPage.status));
  check('/mfa says two-factor is required', mfaHtml.includes('Two-factor authentication required'));
  const preMfaLeaks = ['wal_demo', 'cus_demo', 'KYC', 'Approved', 'Wallet', 'Session expires'].filter((s) => mfaHtml.includes(s));
  check('/mfa shows no KYC, wallet or account data before MFA', preMfaLeaks.length === 0, preMfaLeaks.join(', '));
  await expectRedirect('/dashboard (protected) sends a password-only session to /mfa, nothing rendered', await get('/dashboard', cookie), '/mfa', PROTECTED_TEXT);
  await expectRedirect('/login while signed in redirects to /mfa', await get('/login', cookie), '/mfa');
  await expectRedirect('/ while signed in redirects to /mfa', await get('/', cookie), '/mfa');

  console.log('\nLogout');
  const foreignLogout = await post('/mfa', formFrom(mfaHtml), { origin: 'http://evil.example', cookie });
  check('foreign-Origin logout POST is rejected and the session survives', foreignLogout.status >= 400 && sessionCount() === 1, `${foreignLogout.status} / ${sessionCount()}`);
  const out = await post('/mfa', formFrom(mfaHtml), { cookie });
  const cleared = sessionSetCookie(out);
  check('303 redirect to /login', out.status === 303 && out.headers.get('location') === '/login', `${out.status} ${out.headers.get('location')}`);
  check('session cookie cleared (Max-Age=0 / expired)', /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cleared ?? ''), cleared);
  check('session row deleted', sessionCount() === 0, String(sessionCount()));
  await expectRedirect('the old cookie no longer works', await get('/mfa', cookie), '/login', PROTECTED_TEXT);

  console.log('\nExpired session');
  const bobLogin = await loginAs(bob);
  const bobCookie = cookiePair(sessionSetCookie(bobLogin));
  const writer = new Database(path.join(dataDir, 'db', 'identity.db'));
  writer.prepare('UPDATE session SET expiresAt = ?').run(new Date(Date.now() - 1000).toISOString());
  writer.close();
  await expectRedirect('an expired session redirects to /login, nothing rendered', await get('/mfa', bobCookie), '/login', PROTECTED_TEXT);

  // -------------------------------------------------------------------------
  // TOTP enrollment and verification through the real Server Actions.
  const twoFactorRows = () => identity.prepare('SELECT count(*) AS n FROM twoFactor').get().n;
  const twoFactorEnabled = (email) => identity.prepare('SELECT twoFactorEnabled AS e FROM "user" WHERE email = ?').get(email).e === 1;
  const twoFactorValue = (email) => JSON.stringify(identity.prepare('SELECT twoFactorEnabled AS e, typeof(twoFactorEnabled) AS t FROM "user" WHERE email = ?').get(email));
  const browserLogin = async (user) => {
    const browser = cookieJar();
    const page = await (await get('/login')).text();
    const res = browser.apply(await post('/login', formFrom(page, { email: user.email, password: user.password })));
    return { browser, res };
  };

  console.log('\nMFA enrollment (first login)');
  const { browser: a1 } = await browserLogin(alice);
  const passwordOnlyCookie = a1.header();
  const setupPage = await get('/mfa/setup', a1.header());
  const setupHtml = await setupPage.text();
  check('/mfa/setup asks for the password first', setupPage.status === 200 && setupHtml.includes('confirm your password'), String(setupPage.status));

  const foreignStep1 = await post('/mfa/setup', formFrom(setupHtml, { password: alice.password }), { origin: 'http://evil.example', cookie: a1.header() });
  check('foreign-Origin enrollment POST rejected, nothing created', foreignStep1.status >= 400 && twoFactorRows() === 0, `${foreignStep1.status} / rows ${twoFactorRows()}`);
  const noOriginStep1 = await post('/mfa/setup', formFrom(setupHtml, { password: alice.password }), { origin: null, cookie: a1.header() });
  check('missing-Origin enrollment POST rejected, nothing created', noOriginStep1.status >= 400 && twoFactorRows() === 0, `${noOriginStep1.status} / rows ${twoFactorRows()}`);

  const wrongPw = await post('/mfa/setup', formFrom(setupHtml, { password: 'wrong-password' }), { cookie: a1.header() });
  const wrongPwState = actionState(await wrongPw.text());
  check('wrong password: "Incorrect password." and no secret created', wrongPwState?.error === 'Incorrect password.' && wrongPwState?.step === 'password' && twoFactorRows() === 0, JSON.stringify(wrongPwState));

  const step1 = await post('/mfa/setup', formFrom(setupHtml, { password: alice.password }), { cookie: a1.header() });
  const step1State = actionState(await step1.text());
  const manualKey = step1State?.manualKey?.replaceAll(' ', '');
  check('correct password: next step is "confirm"', step1State?.step === 'confirm', step1State?.step);
  check('correct password: scannable QR code (PNG data URL) returned', /^data:image\/png;base64,[A-Za-z0-9+/]{200,}=*$/.test(step1State?.qrDataUrl ?? ''));
  check('correct password: manual setup key returned', /^[A-Z2-7]{16,}$/.test(manualKey ?? ''), manualKey);
  check('TOTP not active until the first code is verified', twoFactorRows() === 1 && !twoFactorEnabled(alice.email));
  check('no backup codes before verification', !('backupCodes' in (step1State ?? {})));

  // Step 2 is the same form with step=confirm (rendered by the browser from the state above).
  const wrongCode = await post('/mfa/setup', formFrom(setupHtml, { step: 'confirm', code: '000000' }), { cookie: a1.header() });
  const wrongCodeState = actionState(await wrongCode.text());
  check('wrong first code rejected; still not enrolled', /^That code is not valid/.test(wrongCodeState?.error ?? '') && !twoFactorEnabled(alice.email), JSON.stringify(wrongCodeState));

  const step2 = a1.apply(await post('/mfa/setup', formFrom(setupHtml, { step: 'confirm', code: totp(manualKey) }), { cookie: a1.header() }));
  const step2State = actionState(await step2.text());
  const backupCodes = step2State?.backupCodes ?? [];
  check('correct code: enrollment complete', step2.status === 200 && step2State?.step === 'done' && twoFactorEnabled(alice.email), `status ${step2.status} ${step2.headers.get('location')}, ${JSON.stringify(step2State?.step)} ${twoFactorValue(alice.email)}`);
  check('10 backup codes returned once, after verification', backupCodes.length === 10 && backupCodes.every((c) => typeof c === 'string' && c.length >= 8), String(backupCodes.length));
  check('a new session cookie replaced the password-only one', a1.header() !== passwordOnlyCookie && a1.has('better-auth.session_token'));
  await expectRedirect('/dashboard forwards the MFA-verified customer to /wallet', await get('/dashboard', a1.header()), '/wallet');
  const wallet1 = await get('/wallet', a1.header());
  check('/wallet is available to the MFA-verified session', wallet1.status === 200 && (await wallet1.text()).includes('wal_demo_alice'), String(wallet1.status));
  await expectRedirect('the old password-only session was revoked', await get('/dashboard', passwordOnlyCookie), '/login', PROTECTED_TEXT);
  const setupAgain = await get('/mfa/setup', a1.header());
  const setupAgainHtml = await setupAgain.text();
  check('enrollment page offers no new setup once verified',
    setupAgain.status === 200 && setupAgainHtml.includes('already set up') && !setupAgainHtml.includes('name="password"'), String(setupAgain.status));
  const reEnroll = await post('/mfa/setup', formFrom(setupHtml, { password: alice.password }), { cookie: a1.header() });
  check('a verified session cannot start enrollment again', (await redirectOf(reEnroll)).to === '/dashboard' && twoFactorRows() === 1, String(reEnroll.status));

  const logoutFrom = async (browser, page) => {
    const html = await (await get(page, browser.header())).text();
    return browser.apply(await post(page, formFrom(html, {}, 'Sign out'), { cookie: browser.header() }));
  };
  await logoutFrom(a1, '/wallet');
  await expectRedirect('after logout the MFA-verified session is gone', await get('/dashboard', a1.header()), '/login', PROTECTED_TEXT);

  console.log('\nMFA on later sign-ins');
  const { browser: a2, res: a2Login } = await browserLogin(alice);
  check('password login goes to /mfa/verify', a2Login.status === 303 && a2Login.headers.get('location') === '/mfa/verify', `${a2Login.status} ${a2Login.headers.get('location')}`);
  check('only a challenge cookie – no session yet', a2.has('better-auth.two_factor') && !a2.has('better-auth.session_token'));
  await expectRedirect('/dashboard with only the challenge cookie redirects to /login', await get('/dashboard', a2.header()), '/login', PROTECTED_TEXT);
  const verifyHtml = await (await get('/mfa/verify', a2.header())).text();
  check('/mfa/verify offers TOTP and backup-code forms', verifyHtml.includes('authenticator app') && verifyHtml.includes('backup code'));

  const foreignVerify = await post('/mfa/verify', formFrom(verifyHtml, { code: totp(manualKey) }, 0), { origin: 'http://evil.example', cookie: a2.header() });
  check('foreign-Origin verify POST rejected, no session', foreignVerify.status >= 400 && !sessionSetCookie(foreignVerify), String(foreignVerify.status));
  const noOriginVerify = await post('/mfa/verify', formFrom(verifyHtml, { code: totp(manualKey) }, 0), { origin: null, cookie: a2.header() });
  check('missing-Origin verify POST rejected, no session', noOriginVerify.status >= 400 && !sessionSetCookie(noOriginVerify), String(noOriginVerify.status));
  const badTotp = await post('/mfa/verify', formFrom(verifyHtml, { code: '000000' }, 0), { cookie: a2.header() });
  const badTotpState = actionState(await badTotp.text());
  check('wrong TOTP code rejected, no session', /^That code is not valid/.test(badTotpState?.error ?? '') && !sessionSetCookie(badTotp), JSON.stringify(badTotpState));

  const challengeCode = totp(manualKey, Date.now() + 30_000);
  const goodTotp = a2.apply(await post('/mfa/verify', formFrom(verifyHtml, { code: challengeCode }, 0), { cookie: a2.header() }));
  check('correct TOTP: 303 to /dashboard with a new session', goodTotp.status === 303 && goodTotp.headers.get('location') === '/dashboard' && Boolean(sessionSetCookie(goodTotp)), `${goodTotp.status} ${goodTotp.headers.get('location')}`);
  check('no trusted-device cookie issued', !goodTotp.headers.getSetCookie().some((c) => c.startsWith('better-auth.trust_device')));
  check('session row marked mfaVerifiedAt', identity.prepare('SELECT count(*) AS n FROM session WHERE mfaVerifiedAt IS NOT NULL').get().n === 1);
  const wallet2 = await get('/wallet', a2.header());
  check('/wallet available after the challenge', wallet2.status === 200 && (await wallet2.text()).includes('wal_demo_alice'), String(wallet2.status));
  await logoutFrom(a2, '/wallet');

  console.log('\nTOTP replay');
  const { browser: aReplay } = await browserLogin(alice);
  const replayHtml = await (await get('/mfa/verify', aReplay.header())).text();
  const replay = await post('/mfa/verify', formFrom(replayHtml, { code: challengeCode }, 0), { cookie: aReplay.header() });
  const replayState = actionState(await replay.text());
  check('the same TOTP code is refused for a second sign-in challenge', /^That code is not valid/.test(replayState?.error ?? '') && !sessionSetCookie(replay), JSON.stringify(replayState));
  const enrollReplay = await post('/mfa/verify', formFrom(replayHtml, { code: totp(manualKey) }, 0), { cookie: aReplay.header() });
  check('the enrollment code cannot be used for a sign-in either', !sessionSetCookie(enrollReplay), String(enrollReplay.status));

  console.log('\nBackup codes');
  const { browser: a3 } = await browserLogin(alice);
  const verifyHtml3 = await (await get('/mfa/verify', a3.header())).text();
  const viaBackup = a3.apply(await post('/mfa/verify', formFrom(verifyHtml3, { code: backupCodes[0] }, 1), { cookie: a3.header() }));
  check('a backup code completes sign-in', viaBackup.status === 303 && viaBackup.headers.get('location') === '/dashboard', `${viaBackup.status} ${viaBackup.headers.get('location')}`);
  await logoutFrom(a3, '/wallet');
  const { browser: a4 } = await browserLogin(alice);
  const verifyHtml4 = await (await get('/mfa/verify', a4.header())).text();
  const reused = await post('/mfa/verify', formFrom(verifyHtml4, { code: backupCodes[0] }, 1), { cookie: a4.header() });
  const reusedState = actionState(await reused.text());
  check('the same backup code is refused the second time', /not valid or has already been used/.test(reusedState?.error ?? '') && !sessionSetCookie(reused), JSON.stringify(reusedState));

  // -------------------------------------------------------------------------
  // Section 3D: customer and read-only support access.
  const writeDb = (name, fn) => {
    const db = new Database(path.join(dataDir, 'db', `${name}.db`));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  writeDb('transaction', (db) => {
    const ins = db.prepare(`INSERT INTO transfer (transfer_id, sender_wallet_id, payee_type, payee_id, amount_cents, idempotency_key, status, pending_expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending_risk', ?, ?, ?)`);
    const t0 = Date.now() - 60_000;
    [['trf_a_to_b', 'wal_demo_alice', 'wallet', 'wal_demo_bob', 1250], ['trf_b_to_a', 'wal_demo_bob', 'wallet', 'wal_demo_alice', 500],
      ['trf_c_to_b', 'wal_demo_carol', 'wallet', 'wal_demo_bob', 700], ['trf_c_to_m', 'wal_demo_carol', 'merchant', 'mer_demo_coffee', 300]]
      .forEach(([id, from, type, to, amount], i) => ins.run(id, from, type, to, amount, `idem-${id}`, t0 + 600_000, t0 + i, t0 + i));
  });
  const transactionRo = new Database(path.join(dataDir, 'db', 'transaction.db'), { readonly: true, fileMustExist: true });
  extraConnections.push(transactionRo);
  const auditRows = () => transactionRo.prepare('SELECT actor_id, event_type, subject_wallet_id FROM audit_event ORDER BY occurred_at, rowid').all();

  const enrollViaHttp = async (user) => {
    const { browser } = await browserLogin(user);
    const html = await (await get('/mfa/setup', browser.header())).text();
    const s1 = actionState(await (await post('/mfa/setup', formFrom(html, { password: user.password }), { cookie: browser.header() })).text());
    const key = s1.manualKey.replaceAll(' ', '');
    browser.apply(await post('/mfa/setup', formFrom(html, { step: 'confirm', code: totp(key) }), { cookie: browser.header() }));
    return browser;
  };

  console.log('\nCustomer wallet (own data only)');
  const { browser: aw } = await browserLogin(alice);
  const awVerify = await (await get('/mfa/verify', aw.header())).text();
  aw.apply(await post('/mfa/verify', formFrom(awVerify, { code: backupCodes[1] }, 1), { cookie: aw.header() }));
  const walletPage = await get('/wallet', aw.header());
  const walletHtml = (await walletPage.text()).replaceAll('<!-- -->', '');
  check('/wallet shows the customer\'s identity, wallet and KYC status',
    walletPage.status === 200 && walletHtml.includes('Alice Demo') && walletHtml.includes('wal_demo_alice') && walletHtml.includes('Approved'), String(walletPage.status));
  check('/wallet lists the customer\'s own transfers', walletHtml.includes('trf_a_to_b') && walletHtml.includes('trf_b_to_a'));
  const othersData = ['trf_c_to_b', 'trf_c_to_m', 'wal_demo_carol', 'Carol Demo'].filter((s) => walletHtml.includes(s));
  check('/wallet shows nothing from other customers', othersData.length === 0, othersData.join(', '));
  check('/wallet shows Alice\'s own balance ($500.00) via Identity → CBI → mock Core Banking',
    walletHtml.includes('data-balance="available"') && walletHtml.includes('$500.00'), walletHtml.match(/data-balance="\w+"/)?.[0]);
  const internals = ['eyJ', 'MCB-', 'vaultpay-identity', 'vaultpay-cbi', 'corebanking', 'PRIVATE KEY', 'BEGIN CERTIFICATE', 'upstream_error'].filter((s) => walletHtml.includes(s));
  check('the page carries no service token, account reference, key or internal error', internals.length === 0, internals.join(', '));
  await expectRedirect('a customer cannot open /support', await get('/support', aw.header()), '/access-denied', ['Look up customer', 'Customer support (read-only)']);

  console.log('\nRead-only support');
  const sw = await enrollViaHttp(support);
  await expectRedirect('/dashboard forwards the support user to /support', await get('/dashboard', sw.header()), '/support');
  const supportPage = await get('/support', sw.header());
  const supportHtml = await supportPage.text();
  check('/support is available to the MFA-verified support user', supportPage.status === 200 && supportHtml.includes('Customer support (read-only)') && supportHtml.includes('Look up customer'), String(supportPage.status));
  await expectRedirect('support cannot open /wallet', await get('/wallet', sw.header()), '/access-denied', ['Recent transfers']);

  const auditBefore = auditRows().length;
  const lookup = await post('/support', formFrom(supportHtml, { email: alice.email }, 'name="email"'), { cookie: sw.header() });
  const lookupState = actionState(await lookup.text());
  const found = lookupState?.result;
  check('lookup finds the customer by email', found?.found === true && found.customer.customerId === 'cus_demo_alice', JSON.stringify(found)?.slice(0, 200));
  check('contact details are masked', found?.customer.maskedEmail === 'a***e@example.test' && found?.customer.maskedPhone === '+•-•••-••01' && !JSON.stringify(found).includes(alice.email));
  check('wallet, KYC status and transfers are shown', found?.wallet?.walletId === 'wal_demo_alice' && found?.customer.kycStatus === 'approved'
    && JSON.stringify(found?.transfers.map((t) => t.transferId)) === '["trf_b_to_a","trf_a_to_b"]');
  const newAudit = auditRows().slice(auditBefore);
  check('the search and the view are both in the audit trail', JSON.stringify(newAudit) === JSON.stringify([
    { actor_id: 'ops_demo_support', event_type: 'support.customer_search', subject_wallet_id: null },
    { actor_id: 'ops_demo_support', event_type: 'support.customer_view', subject_wallet_id: 'wal_demo_alice' },
  ]), JSON.stringify(newAudit));

  const auditMid = auditRows().length;
  const foreignLookup = await post('/support', formFrom(supportHtml, { email: alice.email }, 'name="email"'), { origin: 'http://evil.example', cookie: sw.header() });
  const noOriginLookup = await post('/support', formFrom(supportHtml, { email: alice.email }, 'name="email"'), { origin: null, cookie: sw.header() });
  check('foreign-Origin and missing-Origin lookups are rejected and leave no audit record',
    foreignLookup.status >= 400 && noOriginLookup.status >= 400 && auditRows().length === auditMid, `${foreignLookup.status} / ${noOriginLookup.status}`);
  const customerReplay = await post('/support', formFrom(supportHtml, { email: bob.email }, 'name="email"'), { cookie: aw.header() });
  const customerReplayRedirect = await redirectOf(customerReplay);
  check('a customer replaying the support lookup action is refused (server-side check)',
    customerReplayRedirect.to === '/access-denied' && !customerReplayRedirect.html.includes('cus_demo_bob') && auditRows().length === auditMid,
    `${customerReplay.status} ${customerReplayRedirect.to}`);
  const notFound = actionState(await (await post('/support', formFrom(supportHtml, { email: 'support@example.test' }, 'name="email"'), { cookie: sw.header() })).text());
  check('ops accounts cannot be looked up ("not found")', notFound?.result?.found === false, JSON.stringify(notFound));

  console.log('\nMFA and account status enforcement');
  const { browser: bw } = await browserLogin(bob);
  await expectRedirect('password-only customer: /wallet → /mfa', await get('/wallet', bw.header()), '/mfa', PROTECTED_TEXT);
  await expectRedirect('password-only customer: /support → /mfa', await get('/support', bw.header()), '/mfa', PROTECTED_TEXT);
  writeDb('identity', (db) => db.prepare("UPDATE customer SET status = 'suspended' WHERE customer_id = 'cus_demo_alice'").run());
  await expectRedirect('a suspended customer is refused on the next request', await get('/wallet', aw.header()), '/access-denied', PROTECTED_TEXT);
  writeDb('identity', (db) => db.prepare("UPDATE customer SET status = 'active' WHERE customer_id = 'cus_demo_alice'").run());
  writeDb('identity', (db) => db.prepare("UPDATE ops_user SET status = 'disabled' WHERE ops_user_id = 'ops_demo_support'").run());
  await expectRedirect('a disabled ops user is refused on the next request', await get('/support', sw.header()), '/access-denied', PROTECTED_TEXT);
  const disabledLookup = await post('/support', formFrom(supportHtml, { email: alice.email }, 'name="email"'), { cookie: sw.header() });
  check('a disabled ops user\'s lookup action is refused', (await redirectOf(disabledLookup)).to === '/access-denied' && auditRows().length === auditMid + 1);
  writeDb('identity', (db) => db.prepare("UPDATE ops_user SET status = 'active' WHERE ops_user_id = 'ops_demo_support'").run());

  // -------------------------------------------------------------------------
  // Section 3E: KYC and wallet eligibility for sending money.
  const sendState = async (browser) => {
    const res = await get('/send', browser.header());
    if (res.status !== 200) return { status: res.status, redirect: (await redirectOf(res)).to };
    const html = (await res.text()).replaceAll('<!-- -->', '');
    return {
      status: 200,
      eligibility: html.match(/data-eligibility="(\w+)"/)?.[1] ?? null,
      reasons: [...html.matchAll(/data-reason="(\w+)"/g)].map((m) => m[1]),
      forms: (html.match(/<form/g) ?? []).length,
      html,
    };
  };
  // Each record strictly newer than the last: the newest KYC record is the current status.
  let kycAt = Date.now() + 1000;
  const addKyc = (status) => writeDb('identity', (db) => {
    const at = (kycAt += 1000);
    db.prepare(`INSERT INTO kyc_verification (verification_id, customer_id, status, verification_ref, verified_at, created_at)
      VALUES (?, 'cus_demo_carol', ?, 'http-check', ?, ?)`).run(`kyc_http_${status}_${at}`, status, status === 'pending' ? null : at, at);
  });

  // Content only the /send page body renders (its static <title> is not data).
  const SEND_CONTENT = ['data-eligibility', 'data-transfer-step', 'Sending money is unavailable'];

  console.log('\nSend money: eligibility (3E)');
  check('/wallet links to /send', (await (await get('/wallet', aw.header())).text()).includes('href="/send"'));
  const aliceSend = await sendState(aw);
  check('Alice is eligible: the transfer form is shown', aliceSend.eligibility === 'eligible' && aliceSend.html.includes('data-transfer-step="edit"')
    && /name="recipient"/.test(aliceSend.html) && /name="amount"/.test(aliceSend.html), JSON.stringify({ ...aliceSend, html: undefined }));

  const cw = await enrollViaHttp(carol);
  const carolWallet = (await (await get('/wallet', cw.header())).text()).replaceAll('<!-- -->', '');
  check('Carol sees only her own balance ($100.00), never Alice\'s', carolWallet.includes('$100.00') && !carolWallet.includes('$500.00') && !carolWallet.includes('wal_demo_alice'));
  const carolPending = await sendState(cw);
  check('Carol (KYC pending) is told transfers are unavailable until KYC is approved',
    carolPending.eligibility === 'ineligible' && JSON.stringify(carolPending.reasons) === '["kyc_pending"]' && carolPending.html.includes('pending'), JSON.stringify(carolPending.reasons));
  addKyc('approved');
  const carolApproved = await sendState(cw);
  check('a new approved KYC record lets Carol through on the next request', carolApproved.eligibility === 'eligible', JSON.stringify(carolApproved.reasons));
  addKyc('rejected');
  const carolRejected = await sendState(cw);
  check('a later rejected KYC record blocks her again', carolRejected.eligibility === 'ineligible' && JSON.stringify(carolRejected.reasons) === '["kyc_rejected"]', JSON.stringify(carolRejected.reasons));
  check('an ineligible customer gets no transfer form', !carolRejected.html.includes('data-transfer-step') && !/name="amount"/.test(carolRejected.html));

  writeDb('identity', (db) => db.prepare("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_alice'").run());
  const frozen = await sendState(aw);
  check('a frozen wallet is refused', frozen.eligibility === 'ineligible' && JSON.stringify(frozen.reasons) === '["wallet_frozen"]', JSON.stringify(frozen.reasons));
  const frozenWallet = (await (await get('/wallet', aw.header())).text()).replaceAll('<!-- -->', '');
  check('a frozen wallet shows no balance', frozenWallet.includes('data-balance="unavailable"') && frozenWallet.includes('frozen or closed wallet') && !frozenWallet.includes('$500.00'));
  writeDb('identity', (db) => db.prepare("UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_alice'").run());
  check('unfreezing applies on the next request (nothing cached)', (await sendState(aw)).eligibility === 'eligible');

  writeDb('identity', (db) => db.prepare("UPDATE customer SET status = 'suspended' WHERE customer_id = 'cus_demo_alice'").run());
  await expectRedirect('a suspended customer cannot open /send', await get('/send', aw.header()), '/access-denied', SEND_CONTENT);
  writeDb('identity', (db) => db.prepare("UPDATE customer SET status = 'active' WHERE customer_id = 'cus_demo_alice'").run());

  await expectRedirect('support cannot open /send', await get('/send', sw.header()), '/access-denied', SEND_CONTENT);
  await expectRedirect('a password-only customer: /send → /mfa', await get('/send', bw.header()), '/mfa', SEND_CONTENT);
  await expectRedirect('signed out: /send → /login', await get('/send'), '/login');

  // -------------------------------------------------------------------------
  // DNS rebinding: a request reaching 127.0.0.1 under a foreign Host name (fetch cannot
  // override Host, so these use node:http directly).
  const rawRequest = (method, p, { host, headers = {}, form } = {}) => new Promise((resolve, reject) => {
    const send = async () => {
      let body;
      const h = { host, ...headers };
      if (form) {
        const r = new Request('http://x/', { method: 'POST', body: form });
        body = Buffer.from(await r.arrayBuffer());
        h['content-type'] = r.headers.get('content-type');
        h['content-length'] = String(body.length);
      }
      const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end(body);
    };
    send().catch(reject);
  });

  // -------------------------------------------------------------------------
  // Step 5: transfers through the real Server Action (review → confirm), the real balance
  // flow (Identity → CBI → mock Core Banking) and the real transaction database.
  console.log('\nSend money: transfers (Step 5)');
  const sendHtml = await (await get('/send', aw.header())).text();
  const TRANSFER_FORM = 'name="recipient"';
  const sendAction = async (browser, fields, opts = {}) => {
    const res = await post('/send', formFrom(sendHtml, fields, TRANSFER_FORM), { cookie: browser.header(), ...opts });
    // A redirect() in the action is a real 303 for a no-JavaScript form POST.
    const { to, html } = await redirectOf(res);
    return { status: res.status, state: actionState(html), html, redirect: to };
  };
  const review = async (browser, recipient, amount) => (await sendAction(browser, { intent: 'review', recipient, amount })).state;
  const confirmFields = (r, change = {}) => ({ intent: 'confirm', recipient: r.recipient, amount: r.amount, sourceWalletId: r.sourceWalletId, idempotencyKey: r.idempotencyKey, ...change });
  const SEEDED = ['trf_a_to_b', 'trf_b_to_a', 'trf_c_to_b', 'trf_c_to_m'];
  const transferRows = () => transactionRo.prepare('SELECT transfer_id, sender_wallet_id, payee_id, amount_cents, status, settlement_attempted_at FROM transfer ORDER BY created_at, rowid').all()
    .filter((r) => !SEEDED.includes(r.transfer_id));
  const transferAudit = (id) => transactionRo.prepare('SELECT actor_type, actor_id, event_type, subject_wallet_id FROM audit_event WHERE transfer_id = ?').all(id);
  const transferOutbox = (id) => transactionRo.prepare('SELECT target, status, attempts FROM outbox_message WHERE transfer_id = ?').all(id);

  const r1 = await review(aw, bob.email, '12.50');
  check('review shows a confirmation (recipient, amount, source wallet) and writes nothing',
    r1?.step === 'confirm' && r1.review.recipient === bob.email && r1.review.amountCents === 1250 && r1.review.sourceWalletId === 'wal_demo_alice'
    && /^[A-Za-z0-9_-]{16,128}$/.test(r1.review.idempotencyKey) && transferRows().length === 0, JSON.stringify(r1));
  const c1 = await sendAction(aw, confirmFields(r1.review));
  const t1 = c1.state?.transfer;
  check('Alice → Bob $12.50: accepted as pending (security check), not completed',
    c1.state?.step === 'done' && t1?.status === 'pending_risk' && t1.amountCents === 1250 && c1.state.replayed === false, JSON.stringify(c1.state));
  const [row1] = transferRows();
  check('the transfer is recorded: sender, recipient wallet, amount, pending_risk, no settlement attempt',
    transferRows().length === 1 && row1.transfer_id === t1?.transferId && row1.sender_wallet_id === 'wal_demo_alice' && row1.payee_id === 'wal_demo_bob'
    && row1.amount_cents === 1250 && row1.status === 'pending_risk' && row1.settlement_attempted_at === null, JSON.stringify(transferRows()));
  check('same database transaction: one transfer.requested audit event and one fraud_check outbox message',
    JSON.stringify(transferAudit(row1?.transfer_id)) === JSON.stringify([{ actor_type: 'customer', actor_id: 'cus_demo_alice', event_type: 'transfer.requested', subject_wallet_id: 'wal_demo_alice' }])
    && JSON.stringify(transferOutbox(row1?.transfer_id)) === JSON.stringify([{ target: 'fraud_check', status: 'pending', attempts: 0 }]),
    JSON.stringify([transferAudit(row1?.transfer_id), transferOutbox(row1?.transfer_id)]));
  const stateLeaks = ['MCB-', 'eyJ', 'balanceCents', 'cus_demo_bob', 'Bob Demo', 'SQLITE', 'vaultpay-cbi'].filter((x) => `${JSON.stringify(r1)}${c1.html}`.includes(x));
  check('review and confirmation responses carry no account reference, token, balance or internal detail', stateLeaks.length === 0, stateLeaks.join(', '));

  const c1again = await sendAction(aw, confirmFields(r1.review));
  check('resubmitting the same confirmation returns the same transfer (no duplicate)',
    c1again.state?.step === 'done' && c1again.state.transfer.transferId === t1?.transferId && c1again.state.replayed === true && transferRows().length === 1, JSON.stringify(c1again.state));
  const conflict = await sendAction(aw, confirmFields(r1.review, { amount: '99.00' }));
  check('the same idempotency key with a different amount is refused', conflict.state?.error === 'idempotency_conflict' && transferRows().length === 1, JSON.stringify(conflict.state));

  const r2 = (await review(aw, bob.email, '3.00')).review;
  const parallel = await Promise.all(Array.from({ length: 5 }, () => sendAction(aw, confirmFields(r2))));
  const parallelIds = new Set(parallel.map((p) => p.state?.transfer?.transferId));
  check('5 concurrent submissions of one confirmation create exactly one transfer',
    parallel.every((p) => p.state?.step === 'done') && parallelIds.size === 1 && transferRows().length === 2, JSON.stringify(parallel.map((p) => p.state?.error ?? p.status)));

  const r3 = (await review(aw, bob.email, '4.00')).review;
  const foreignSend = await post('/send', formFrom(sendHtml, confirmFields(r3), TRANSFER_FORM), { origin: 'http://evil.example', cookie: aw.header() });
  const noOriginSend = await post('/send', formFrom(sendHtml, confirmFields(r3), TRANSFER_FORM), { origin: null, cookie: aw.header() });
  check('foreign-Origin and missing-Origin transfer POSTs are rejected; nothing is written',
    foreignSend.status >= 400 && noOriginSend.status >= 400 && transferRows().length === 2, `${foreignSend.status} / ${noOriginSend.status}`);
  const rebTransfer = await rawRequest('POST', '/send', { host: `evil.example:${PORT}`, headers: { origin: `http://evil.example:${PORT}`, cookie: aw.header() }, form: formFrom(sendHtml, confirmFields(r3), TRANSFER_FORM) });
  check('a "same-origin" transfer POST under a foreign Host (DNS rebinding) is rejected', rebTransfer.status >= 400 && transferRows().length === 2, String(rebTransfer.status));

  const tampered = await sendAction(aw, confirmFields(r3, { sourceWalletId: 'wal_demo_bob' }));
  check('a confirmation naming another customer\'s wallet as the source is refused', tampered.state?.error === 'source_wallet_changed' && transferRows().length === 2, JSON.stringify(tampered.state));
  const selfReview = await review(aw, 'ALICE@example.test', '1.00');
  const selfConfirm = await sendAction(aw, confirmFields({ ...r3, recipient: alice.email }));
  check('self-transfers are refused (review and a crafted confirm)', selfReview?.error === 'self_transfer' && selfConfirm.state?.error === 'self_transfer', JSON.stringify([selfReview, selfConfirm.state]));
  const amountChecks = [];
  for (const [amount, error] of [['abc', 'invalid_amount'], ['12.345', 'invalid_amount'], ['-5', 'invalid_amount'], ['0', 'amount_out_of_range'], ['1000.01', 'amount_out_of_range']]) {
    amountChecks.push([(await sendAction(aw, confirmFields(r3, { amount, idempotencyKey: 'http-amount-key-0001' }))).state?.error, error]);
  }
  check('invalid amounts and amounts over the $1,000 limit are refused', amountChecks.every(([got, want]) => got === want) && transferRows().length === 2, JSON.stringify(amountChecks));
  const unknownRecipient = await sendAction(aw, confirmFields(r3, { recipient: 'nobody@example.test' }));
  const staffRecipient = await sendAction(aw, confirmFields(r3, { recipient: support.email }));
  check('unknown and staff recipients get the same generic refusal', unknownRecipient.state?.error === 'invalid_recipient' && staffRecipient.state?.error === 'invalid_recipient'
    && JSON.stringify(Object.keys(unknownRecipient.state)) === JSON.stringify(Object.keys(staffRecipient.state)), JSON.stringify([unknownRecipient.state, staffRecipient.state]));

  const carolReplay = await sendAction(cw, confirmFields(r3, { sourceWalletId: 'wal_demo_carol' }));
  check('Carol (KYC rejected) replaying the transfer action is refused → /send', carolReplay.redirect === '/send' && transferRows().length === 2, `${carolReplay.status} ${carolReplay.redirect} ${JSON.stringify(carolReplay.state)}`);
  const supportReplay = await sendAction(sw, confirmFields(r3));
  const pwOnlyReplay = await sendAction(bw, confirmFields(r3, { sourceWalletId: 'wal_demo_bob', recipient: alice.email }));
  check('support (wrong role) and a password-only session cannot submit transfers', supportReplay.redirect === '/access-denied' && pwOnlyReplay.redirect === '/mfa' && transferRows().length === 2,
    `${supportReplay.redirect} / ${pwOnlyReplay.redirect}`);
  writeDb('identity', (db) => db.prepare("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_alice'").run());
  const frozenSend = await sendAction(aw, confirmFields(r3));
  writeDb('identity', (db) => db.prepare("UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_alice'").run());
  writeDb('identity', (db) => db.prepare("UPDATE customer SET status = 'suspended' WHERE customer_id = 'cus_demo_alice'").run());
  const suspendedSend = await sendAction(aw, confirmFields(r3));
  writeDb('identity', (db) => db.prepare("UPDATE customer SET status = 'active' WHERE customer_id = 'cus_demo_alice'").run());
  check('a frozen wallet (→ /send) and a suspended customer (→ /access-denied) cannot submit', frozenSend.redirect === '/send' && suspendedSend.redirect === '/access-denied' && transferRows().length === 2,
    `${frozenSend.redirect} / ${suspendedSend.redirect}`);
  writeDb('identity', (db) => db.prepare("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_bob'").run());
  const frozenRecipient = await sendAction(aw, confirmFields(r3));
  writeDb('identity', (db) => db.prepare("UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_bob'").run());
  check('a frozen recipient wallet cannot receive', frozenRecipient.state?.error === 'invalid_recipient' && transferRows().length === 2, JSON.stringify(frozenRecipient.state));

  addKyc('approved'); // Carol: $100.00 at the bank
  const carolBig = await sendAction(cw, confirmFields((await review(cw, bob.email, '100.01')).review));
  check('insufficient funds (Carol, $100.00 balance, sends $100.01) is refused', carolBig.state?.error === 'insufficient_funds' && transferRows().length === 2, JSON.stringify(carolBig.state));
  addKyc('rejected');

  const aliceWalletAfter = (await (await get('/wallet', aw.header())).text()).replaceAll('<!-- -->', '');
  // Pending outgoing: the seeded trf_a_to_b ($12.50) plus the two new transfers ($12.50 + $3.00).
  check('/wallet shows the new transfers as "Pending – security check", with the pending total',
    aliceWalletAfter.includes(t1?.transferId) && /data-status="pending_risk">Pending – security check</.test(aliceWalletAfter)
    && aliceWalletAfter.includes('data-pending-outgoing="2800"') && !/data-status="completed"/.test(aliceWalletAfter), aliceWalletAfter.match(/data-pending-outgoing="\d+"/)?.[0]);
  const carolAfter = await (await get('/wallet', cw.header())).text();
  check('other customers do not see the transfer', !carolAfter.includes(t1?.transferId) && !carolAfter.includes('wal_demo_alice'));
  check('no transfer was reported or stored as completed', transferRows().every((r) => r.status === 'pending_risk')
    && transactionRo.prepare('SELECT count(*) AS n FROM ledger_entry').get().n === 0);

  // -------------------------------------------------------------------------
  // Step 6: the fraud outbox worker command against the real Fraud & Risk process.
  console.log('\nFraud screening (Step 6)');
  const rRisky = (await review(aw, bob.email, '300.00')).review;
  const risky = (await sendAction(aw, confirmFields(rRisky))).state?.transfer;
  check('a high-risk $300.00 transfer is accepted as pending first', risky?.status === 'pending_risk', JSON.stringify(risky));
  const workerRun = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'services', 'orchestrator', 'fraud-worker.js'), '--once'], {
      cwd: root, env: { ...process.env, VAULTPAY_DATA_DIR: dataDir, VAULTPAY_FRAUD_PORT: String(services.ports.fraud) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('exit', (code) => resolve({ code, text }));
  });
  check('npm run fraud-worker -- --once: 2 approved, 1 declined', workerRun.code === 0 && /pending_settlement=2/.test(workerRun.text) && /declined=1/.test(workerRun.text), workerRun.text.trim().split('\n').at(-1));
  const statusOf = (id) => transactionRo.prepare('SELECT status FROM transfer WHERE transfer_id = ?').get(id)?.status;
  check('Alice → Bob $12.50 approved → pending_settlement; $300.00 declined', statusOf(t1?.transferId) === 'pending_settlement' && statusOf(risky?.transferId) === 'declined',
    `${statusOf(t1?.transferId)} / ${statusOf(risky?.transferId)}`);
  const aliceScreened = (await (await get('/wallet', aw.header())).text()).replaceAll('<!-- -->', '');
  // [data-status, label] of the table row that holds transfer `id`.
  const rowStatus = (id) => {
    const row = aliceScreened.split('<tr>').find((r) => r.includes(id)) ?? '';
    return row.match(/data-status="([a-z_]+)">([^<]*)</)?.slice(1, 3);
  };
  check('/wallet shows "Pending – awaiting settlement" and "Declined"',
    JSON.stringify(rowStatus(t1?.transferId)) === JSON.stringify(['pending_settlement', 'Pending – awaiting settlement'])
    && JSON.stringify(rowStatus(risky?.transferId)) === JSON.stringify(['declined', 'Declined']), JSON.stringify([rowStatus(t1?.transferId), rowStatus(risky?.transferId)]));
  check('a declined transfer no longer counts as pending outgoing', aliceScreened.includes('data-pending-outgoing="2800"'), aliceScreened.match(/data-pending-outgoing="[0-9]+"/)?.[0]);
  const screenLeaks = ['eyJ', 'rsk_', 'risk_score', 'amount_over_limit', 'vaultpay-fraud'].filter((s) => aliceScreened.includes(s));
  check('the page shows no decision token, decision id, score or rule', screenLeaks.length === 0, screenLeaks.join(', '));
  check('the worker output carries no decision token or key', !/eyJ|PRIVATE KEY/.test(workerRun.text));
  check('nothing completed or posted before settlement', transactionRo.prepare("SELECT count(*) AS n FROM transfer WHERE status = 'completed'").get().n === 0
    && transactionRo.prepare('SELECT count(*) AS n FROM ledger_entry').get().n === 0);

  // -------------------------------------------------------------------------
  // Step 7: the settlement worker command against the real Settlement, Identity, CBI and
  // mock Core Banking processes; the wallet shows the confirmed result and the new balance.
  console.log('\nSettlement (Step 7)');
  const runWorker = (name) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'services', 'orchestrator', `${name}.js`), '--once'], {
      cwd: root, env: { ...process.env, VAULTPAY_DATA_DIR: dataDir, VAULTPAY_SETTLEMENT_PORT: String(services.ports.settlement), VAULTPAY_FRAUD_PORT: String(services.ports.fraud) },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('exit', (code) => resolve({ code, text }));
  });
  const settleRun = await runWorker('settlement-worker');
  check('npm run settlement-worker -- --once: both approved transfers completed', settleRun.code === 0 && /completed=2/.test(settleRun.text), settleRun.text.trim().split('\n').at(-1));
  check('Alice → Bob $12.50 is completed only now (bank posting confirmed)', statusOf(t1?.transferId) === 'completed'
    && transactionRo.prepare("SELECT count(*) AS n FROM settlement_attempt WHERE transfer_id = ? AND outcome = 'settled' AND core_banking_ref IS NOT NULL").get(t1?.transferId).n === 1);
  const ledgerTotals = transactionRo.prepare('SELECT debit_cents, credit_cents, entries FROM ledger_totals').get();
  check('ledger: 2 transfers × (debit + credit), debits = credits = $15.50', JSON.stringify(ledgerTotals) === JSON.stringify({ debit_cents: 1550, credit_cents: 1550, entries: 4 }), JSON.stringify(ledgerTotals));
  const aliceSettled = (await (await get('/wallet', aw.header())).text()).replaceAll('<!-- -->', '');
  const settledRow = (id) => (aliceSettled.split('<tr>').find((r) => r.includes(id)) ?? '').match(/data-status="([a-z_]+)">([^<]*)</)?.slice(1, 3);
  check('/wallet shows "Completed" and still "Declined"',
    JSON.stringify(settledRow(t1?.transferId)) === JSON.stringify(['completed', 'Completed']) && JSON.stringify(settledRow(risky?.transferId)) === JSON.stringify(['declined', 'Declined']),
    JSON.stringify([settledRow(t1?.transferId), settledRow(risky?.transferId)]));
  check('/wallet shows Alice\'s new bank balance ($484.50) via Identity → CBI', aliceSettled.includes('data-balance="available"') && aliceSettled.includes('$484.50'), aliceSettled.match(/data-balance="\w+"/)?.[0]);
  check('only the unsettled seeded test transfer is still pending outgoing', aliceSettled.includes('data-pending-outgoing="1250"'), aliceSettled.match(/data-pending-outgoing="[0-9]+"/)?.[0]);
  const settleLeaks = ['MCB-', 'MCBP-', 'stlk_', 'rsk_', 'eyJ', 'corebanking', 'settlement_attempt'].filter((s) => aliceSettled.includes(s));
  check('the page shows no bank account, posting reference, idempotency key or token', settleLeaks.length === 0, settleLeaks.join(', '));
  check('the worker output carries no token or bank account', !/eyJ|MCB-1/.test(settleRun.text));

  // -------------------------------------------------------------------------
  // Step 8: the read-only operations overview.
  console.log('\nOperations overview (Step 8)');
  const opsViews = () => transactionRo.prepare("SELECT count(*) AS n FROM audit_event WHERE event_type = 'support.operations_view'").get().n;
  const viewsBefore = opsViews();
  const opsRes = await get('/operations', sw.header());
  const opsHtml = (await opsRes.text()).replaceAll('<!-- -->', '');
  check('support (MFA) sees the operations overview', opsRes.status === 200 && opsHtml.includes('Operations (read-only)') && opsHtml.includes('data-count="completed">2<'), opsHtml.match(/data-count="completed">\d+</)?.[0]);
  check('it shows outbox, reconciliation and ledger integrity (balanced)', opsHtml.includes('data-table="outbox"') && opsHtml.includes('Reconciliation') && opsHtml.includes('data-ledger-balanced="true"'));
  check('the view is recorded in the audit trail', opsViews() === viewsBefore + 1, `${viewsBefore} → ${opsViews()}`);
  check('no form or action besides sign-out', (opsHtml.match(/<form/g) ?? []).length === 1 && !/name="(transfer|status|amount|kyc)/.test(opsHtml));
  const opsLeaks = ['MCB-', 'MCBP-', 'stlk_', 'rsk_', 'eyJ', 'wal_demo', 'cus_demo', '@example.test', 'Alice Demo', 'Bob Demo', 'PRIVATE KEY'].filter((s) => opsHtml.includes(s));
  check('no bank account, posting reference, key, token, wallet or customer detail on the page', opsLeaks.length === 0, opsLeaks.join(', '));
  await expectRedirect('a customer cannot open /operations', await get('/operations', aw.header()), '/access-denied', ['Operations (read-only)', 'data-count']);
  await expectRedirect('a password-only session cannot open /operations', await get('/operations', bw.header()), '/mfa', ['Operations (read-only)', 'data-count']);
  await expectRedirect('signed out: /operations → /login', await get('/operations'), '/login');
  check('refused views are not recorded as views', opsViews() === viewsBefore + 1);
  await new Promise((r) => setTimeout(r, 2100));
  await (await get('/operations', sw.header())).text();
  check('a later reload is recorded as a new view', opsViews() === viewsBefore + 2, String(opsViews() - viewsBefore));
  check('/support links to the overview', (await (await get('/support', sw.header())).text()).includes('href="/operations"'));

  // -------------------------------------------------------------------------
  console.log('\nDNS rebinding (foreign Host header)');
  const evilHost = `evil.example:${PORT}`;
  const rebHealth = await rawRequest('GET', '/api/health', { host: evilHost });
  check('/api/health refuses a foreign Host (403, no details)', rebHealth.status === 403 && rebHealth.text === '{"status":"forbidden"}', `${rebHealth.status} ${rebHealth.text}`);
  const rebLoginPage = await (await get('/login')).text();
  const rebLogin = await rawRequest('POST', '/login', {
    host: evilHost, headers: { origin: `http://${evilHost}` }, form: formFrom(rebLoginPage, { email: bob.email, password: bob.password }),
  });
  const rebSetCookie = [].concat(rebLogin.headers['set-cookie'] ?? []).find((c) => c.startsWith('better-auth.session_token='));
  check('a "same-origin" login POST under a foreign Host is refused, no session', rebLogin.status >= 400 && !rebSetCookie, `${rebLogin.status}`);
  const rebWallet = await rawRequest('GET', '/wallet', { host: evilHost, headers: { cookie: aw.header() } });
  const rebWalletTarget = rebWallet.status >= 300 && rebWallet.status < 400 ? new URL(rebWallet.headers.location, base).pathname : rebWallet.text.match(/NEXT_REDIRECT;(?:replace|push);([^;"\\]+);/)?.[1];
  check('a valid session cookie under a foreign Host resolves to no session (nothing rendered)',
    rebWalletTarget === '/login' && !rebWallet.text.includes('wal_demo_alice'), `${rebWallet.status} ${rebWalletTarget}`);

  // -------------------------------------------------------------------------
  // Balance with a dependency down: a safe message, nothing internal.
  console.log('\nBalance when a service is down (4B)');
  const balanceState = async () => {
    const html = (await (await get('/wallet', aw.header())).text()).replaceAll('<!-- -->', '');
    return { state: html.match(/data-balance="(\w+)"/)?.[1], html };
  };
  check('baseline: balance available', (await balanceState()).state === 'available');
  const bobBrowser = await enrollViaHttp(bob);
  const bobWallet = (await (await get('/wallet', bobBrowser.header())).text()).replaceAll('<!-- -->', '');
  // (Bob's history legitimately names Alice's wallet as the sender of trf_a_to_b; her balance must not appear.)
  // $250.00 + the two settled transfers from Alice ($12.50 + $3.00).
  check('Bob sees only his own balance ($265.50), never Alice\'s', bobWallet.includes('data-balance="available"') && bobWallet.includes('$265.50') && !bobWallet.includes('$484.50'),
    `balance=${bobWallet.match(/data-balance="(\w+)"/)?.[1]} redirect=${bobWallet.match(/NEXT_REDIRECT;\w+;([^;]+);/)?.[1]} amounts=${(bobWallet.match(/\$\d+\.\d\d/g) ?? []).join(',')}`);
  await services.bank.stop();
  const bankDown = await balanceState();
  check('mock Core Banking down → "temporarily unavailable"', bankDown.state === 'unavailable' && bankDown.html.includes('temporarily unavailable'));
  await services.cbi.stop();
  const cbiDown = await balanceState();
  check('CBI down → "temporarily unavailable"', cbiDown.state === 'unavailable' && cbiDown.html.includes('temporarily unavailable'));
  const downLeaks = ['ECONNREFUSED', 'cbi_503', 'unavailable:', 'upstream', 'MCB-', 'eyJ', '    at ', 'Error:'].filter((s) => `${bankDown.html}${cbiDown.html}`.includes(s));
  check('outage pages reveal nothing internal', downLeaks.length === 0, downLeaks.join(', '));
  const rDown = (await review(aw, bob.email, '2.00')).review;
  const downSend = await sendAction(aw, confirmFields(rDown));
  check('a transfer while banking is down fails closed: not accepted, nothing written, same key kept for retry',
    downSend.state?.step === 'confirm' && downSend.state.error === 'banking_unavailable' && downSend.state.review.idempotencyKey === rDown.idempotencyKey && transferRows().length === 3,
    JSON.stringify(downSend.state));
  const downReplay = await sendAction(aw, confirmFields(r1.review));
  check('confirming an already recorded transfer again still answers from the database', downReplay.state?.replayed === true && downReplay.state.transfer.transferId === t1?.transferId);
  const downLeaks2 = ['ECONNREFUSED', 'cbi_', 'MCB-', 'eyJ', 'SQLITE', '    at '].filter((x) => downSend.html.includes(x));
  check('the outage refusal reveals nothing internal', downLeaks2.length === 0, downLeaks2.join(', '));
  check('the wallet page still works without a balance', cbiDown.html.includes('wal_demo_alice') && cbiDown.html.includes('Recent transfers'));

  // Last, because it locks Carol's sign-in for 15 minutes in this server process.
  console.log('\nRate limiting');
  for (let i = 0; i < 5; i += 1) await loginAs(carol, `wrong-${i}`);
  const limited = await loginAs(carol);
  const limitedHtml = await limited.text();
  check('6th attempt is blocked even with the right password',
    limited.status === 200 && /^Too many sign-in attempts/.test(actionState(limitedHtml)?.error ?? '') && !sessionSetCookie(limited), JSON.stringify(actionState(limitedHtml)));
} catch (err) {
  failures += 1;
  console.log(`  FAIL  ${err.stack ?? err.message}`);
} finally {
  for (const db of extraConnections) db.close();
  identity.close();
  server.kill();
  await exited;
  await Promise.all([services.settlement.stop(), services.fraud.stop(), services.cbi.stop(), services.identity.stop(), services.bank.stop()]);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

if (failures > 0) console.log(`\n--- server log (last 4000 characters) ---\n${output.slice(-4000)}`);
console.log(failures === 0 ? '\nALL HTTP CHECKS PASSED' : `\n${failures} HTTP CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

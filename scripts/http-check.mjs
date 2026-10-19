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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { totp } from '../tests/helpers/totp.mjs';

import { DEMO_CUSTOMERS } from './setup/demo-data.mjs';
import { runSetup } from './setup/run.mjs';

const PORT = 3999;
const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [alice, bob, carol] = DEMO_CUSTOMERS;
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

const server = spawn(process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), ...startArgs, '--port', String(PORT)], {
  cwd: root,
  env: { ...process.env, VAULTPAY_DATA_DIR: dataDir },
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
function formFrom(html, fields = {}, index = 0) {
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
  const form = forms[index];
  if (!form) throw new Error(`no form #${index} on page`);
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
const PROTECTED_TEXT = ['Signed in as', 'Welcome,', 'Session expires'];

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

  console.log('\nRate limiting');
  for (let i = 0; i < 5; i += 1) await loginAs(carol, `wrong-${i}`);
  const limited = await loginAs(carol);
  const limitedHtml = await limited.text();
  check('6th attempt is blocked even with the right password',
    limited.status === 200 && /^Too many sign-in attempts/.test(actionState(limitedHtml)?.error ?? '') && !sessionSetCookie(limited), JSON.stringify(actionState(limitedHtml)));

  // -------------------------------------------------------------------------
  // TOTP enrollment and verification through the real Server Actions.
  const twoFactorRows = () => identity.prepare('SELECT count(*) AS n FROM twoFactor').get().n;
  const twoFactorEnabled = (email) => identity.prepare('SELECT twoFactorEnabled AS e FROM "user" WHERE email = ?').get(email).e === 1;
  const twoFactorValue = (email) => JSON.stringify(identity.prepare('SELECT twoFactorEnabled AS e, typeof(twoFactorEnabled) AS t FROM "user" WHERE email = ?').get(email));
  // React separates adjacent text nodes with <!-- -->, e.g. "Welcome, <!-- -->Alice Demo".
  const welcomes = (html, name) => html.replaceAll('<!-- -->', '').includes(`Welcome, ${name}`);
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
  const dash1 = await get('/dashboard', a1.header());
  check('/dashboard is available to the MFA-verified session', dash1.status === 200 && welcomes(await dash1.text(), 'Alice Demo'), String(dash1.status));
  await expectRedirect('the old password-only session was revoked', await get('/dashboard', passwordOnlyCookie), '/login', PROTECTED_TEXT);
  const setupAgain = await get('/mfa/setup', a1.header());
  const setupAgainHtml = await setupAgain.text();
  check('enrollment page offers no new setup once verified',
    setupAgain.status === 200 && setupAgainHtml.includes('already set up') && !setupAgainHtml.includes('name="password"'), String(setupAgain.status));
  const reEnroll = await post('/mfa/setup', formFrom(setupHtml, { password: alice.password }), { cookie: a1.header() });
  check('a verified session cannot start enrollment again', (await redirectOf(reEnroll)).to === '/dashboard' && twoFactorRows() === 1, String(reEnroll.status));

  const logoutFrom = async (browser, page) => {
    const html = await (await get(page, browser.header())).text();
    return browser.apply(await post(page, formFrom(html), { cookie: browser.header() }));
  };
  await logoutFrom(a1, '/dashboard');
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

  const goodTotp = a2.apply(await post('/mfa/verify', formFrom(verifyHtml, { code: totp(manualKey, Date.now() + 30_000) }, 0), { cookie: a2.header() }));
  check('correct TOTP: 303 to /dashboard with a new session', goodTotp.status === 303 && goodTotp.headers.get('location') === '/dashboard' && Boolean(sessionSetCookie(goodTotp)), `${goodTotp.status} ${goodTotp.headers.get('location')}`);
  check('no trusted-device cookie issued', !goodTotp.headers.getSetCookie().some((c) => c.startsWith('better-auth.trust_device')));
  check('session row marked mfaVerifiedAt', identity.prepare('SELECT count(*) AS n FROM session WHERE mfaVerifiedAt IS NOT NULL').get().n === 1);
  const dash2 = await get('/dashboard', a2.header());
  check('/dashboard available after the challenge', dash2.status === 200 && welcomes(await dash2.text(), 'Alice Demo'), String(dash2.status));
  await logoutFrom(a2, '/dashboard');

  console.log('\nBackup codes');
  const { browser: a3 } = await browserLogin(alice);
  const verifyHtml3 = await (await get('/mfa/verify', a3.header())).text();
  const viaBackup = a3.apply(await post('/mfa/verify', formFrom(verifyHtml3, { code: backupCodes[0] }, 1), { cookie: a3.header() }));
  check('a backup code completes sign-in', viaBackup.status === 303 && viaBackup.headers.get('location') === '/dashboard', `${viaBackup.status} ${viaBackup.headers.get('location')}`);
  await logoutFrom(a3, '/dashboard');
  const { browser: a4 } = await browserLogin(alice);
  const verifyHtml4 = await (await get('/mfa/verify', a4.header())).text();
  const reused = await post('/mfa/verify', formFrom(verifyHtml4, { code: backupCodes[0] }, 1), { cookie: a4.header() });
  const reusedState = actionState(await reused.text());
  check('the same backup code is refused the second time', /not valid or has already been used/.test(reusedState?.error ?? '') && !sessionSetCookie(reused), JSON.stringify(reusedState));
} catch (err) {
  failures += 1;
  console.log(`  FAIL  ${err.stack ?? err.message}`);
} finally {
  identity.close();
  server.kill();
  await exited;
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(failures === 0 ? '\nALL HTTP CHECKS PASSED' : `\n${failures} HTTP CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

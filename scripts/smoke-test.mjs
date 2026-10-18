// VaultPay – Phase 0 dependency smoke test
//
// Purpose: prove that every library we chose works on THIS computer
// (Windows + Node 22) before any real code depends on it.
// It writes only to a temporary folder outside the project and deletes it at the end.
//
// Run with:  npm run smoke

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

// Runs one section; an unexpected error fails that section without hiding the others.
async function section(title, fn) {
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  unexpected error: ${err?.message ?? err}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultpay-smoke-'));

// ---------------------------------------------------------------------------
await section('1. Node.js', async () => {
  const major = Number(process.versions.node.split('.')[0]);
  check(`Node major version is 22 (found ${process.versions.node})`, major === 22);
});

// ---------------------------------------------------------------------------
await section('2. better-sqlite3 (native module loads; read-only + append-only behave as expected)', async () => {
  const { default: Database } = await import('better-sqlite3');
  const file = path.join(tmpDir, 'sqlite-check.db');

  const db = new Database(file);
  db.exec(`
    CREATE TABLE ledger_entry (id INTEGER PRIMARY KEY, amount_cents INTEGER NOT NULL);
    CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entry
      BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
    CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entry
      BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
  `);
  // Parameterized insert – the only way we will ever pass values into SQL.
  db.prepare('INSERT INTO ledger_entry (amount_cents) VALUES (?)').run(1250);
  check('parameterized insert works', db.prepare('SELECT COUNT(*) AS n FROM ledger_entry').get().n === 1);

  let blocked = false;
  try { db.prepare('UPDATE ledger_entry SET amount_cents = 0').run(); } catch { blocked = true; }
  check('append-only trigger blocks UPDATE', blocked);
  blocked = false;
  try { db.prepare('DELETE FROM ledger_entry').run(); } catch { blocked = true; }
  check('append-only trigger blocks DELETE', blocked);
  db.close();

  // fileMustExist: SQLite must NOT silently create a new empty database (threat 305 groundwork).
  let refused = false;
  try { new Database(path.join(tmpDir, 'does-not-exist.db'), { fileMustExist: true }); } catch { refused = true; }
  check('fileMustExist refuses a missing database file', refused);

  // Read-only connection: SQLite itself refuses writes (threat 244 / Ops Support groundwork).
  const ro = new Database(file, { readonly: true, fileMustExist: true });
  let code = '';
  try { ro.prepare('INSERT INTO ledger_entry (amount_cents) VALUES (?)').run(1); } catch (err) { code = err.code; }
  check('read-only connection rejects writes (SQLITE_READONLY)', code === 'SQLITE_READONLY', `got "${code}"`);
  ro.close();
});

// ---------------------------------------------------------------------------
await section('3. Zod (strict validation rejects unexpected input)', async () => {
  const { z } = await import('zod');
  const Transfer = z.object({
    payeeWalletId: z.string().min(1).max(64),
    amountCents: z.number().int().positive().max(1_000_000),
  }).strict();

  check('valid input accepted', Transfer.safeParse({ payeeWalletId: 'w_123', amountCents: 500 }).success);
  check('unknown field rejected', !Transfer.safeParse({ payeeWalletId: 'w_123', amountCents: 500, senderWalletId: 'w_999' }).success);
  check('fractional amount rejected', !Transfer.safeParse({ payeeWalletId: 'w_123', amountCents: 5.5 }).success);
  check('string amount rejected', !Transfer.safeParse({ payeeWalletId: 'w_123', amountCents: '500' }).success);
  const polluted = JSON.parse('{"payeeWalletId":"w_1","amountCents":1,"__proto__":{"isAdmin":true}}');
  check('__proto__ payload rejected', !Transfer.safeParse(polluted).success);
});

// ---------------------------------------------------------------------------
await section('4. jose (Ed25519 tokens: strict issuer / audience / algorithm / expiry checks)', async () => {
  const { SignJWT, jwtVerify, UnsecuredJWT } = await import('jose');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');

  const sign = (claims, key = privateKey, exp = '60s') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('vaultpay-identity')
      .setSubject('orchestrator')
      .setAudience('fraud-risk-check')
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key);

  const verifyOptions = {
    algorithms: ['EdDSA'],
    issuer: 'vaultpay-identity',
    audience: 'fraud-risk-check',
    maxTokenAge: '60s',
    requiredClaims: ['scope', 'transfer_id'],
  };
  const rejects = async (token, opts = verifyOptions) => {
    try { await jwtVerify(token, publicKey, opts); return false; } catch { return true; }
  };

  const claims = { scope: 'risk:screen', transfer_id: 't_1' };
  const good = await sign(claims);
  const { payload } = await jwtVerify(good, publicKey, verifyOptions);
  check('valid token accepted', payload.transfer_id === 't_1');
  check('token signed with a different key rejected', await rejects(await sign(claims, other.privateKey)));
  check('wrong audience rejected', await rejects(good, { ...verifyOptions, audience: 'settlement' }));
  check('missing required claim rejected', await rejects(await sign({ scope: 'risk:screen' })));
  check('expired token rejected', await rejects(await sign(claims, privateKey, Math.floor(Date.now() / 1000) - 10)));
  const unsigned = new UnsecuredJWT(claims).setIssuer('vaultpay-identity').setAudience('fraud-risk-check').encode();
  check('unsigned ("alg: none") token rejected', await rejects(unsigned));
  const [h, , s] = good.split('.');
  const tampered = `${h}.${Buffer.from(JSON.stringify({ ...payload, transfer_id: 't_2' })).toString('base64url')}.${s}`;
  check('edited payload rejected', await rejects(tampered));
});

// ---------------------------------------------------------------------------
await section('5. selfsigned (dev CA + mTLS handshake with Node https)', async () => {
  const { default: selfsigned } = await import('selfsigned');
  const notAfterDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const base = { keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notAfterDate };

  const makeCa = (cn) => selfsigned.generate([{ name: 'commonName', value: cn }], {
    ...base,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  const makeLeaf = (cn, ca, usage) => selfsigned.generate([{ name: 'commonName', value: cn }], {
    ...base,
    ca: { key: ca.private, cert: ca.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', ...usage },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
    ],
  });

  const ca = await makeCa('VaultPay Dev CA (smoke test)');
  const rogueCa = await makeCa('Rogue CA');
  const server = await makeLeaf('vaultpay-cbi', ca, { serverAuth: true });
  const client = await makeLeaf('vaultpay-settlement', ca, { clientAuth: true });
  const rogueClient = await makeLeaf('vaultpay-settlement', rogueCa, { clientAuth: true });

  const caCert = new crypto.X509Certificate(ca.cert);
  const leafCert = new crypto.X509Certificate(server.cert);
  check('CA certificate is marked as a CA', caCert.ca === true);
  check('server certificate is signed by the dev CA', leafCert.verify(caCert.publicKey));

  // Server requires a client certificate from our CA.
  const srv = https.createServer(
    { key: server.private, cert: server.cert, ca: ca.cert, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const peer = req.socket.getPeerCertificate();
      res.end(peer?.subject?.CN ?? 'unknown');
    },
  );
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();

  const request = (opts) => new Promise((resolve) => {
    // agent: false – a fresh connection per request, so no TLS session is reused between checks.
    const req = https.request({ host: '127.0.0.1', port, path: '/', servername: 'localhost', timeout: 3000, agent: false, ...opts }, (res) => {
      // Read the server's certificate now: the socket is released once the response ends.
      const serverCn = res.socket.getPeerCertificate()?.subject?.CN;
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: true, body, serverCn }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code ?? err.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });

  const good = await request({ ca: ca.cert, key: client.private, cert: client.cert });
  check('mTLS succeeds with a client certificate from our CA', good.ok, good.error);
  check('server sees the client name "vaultpay-settlement"', good.body === 'vaultpay-settlement', good.body);
  check('client sees the server name "vaultpay-cbi"', good.serverCn === 'vaultpay-cbi', good.serverCn);

  const noCert = await request({ ca: ca.cert });
  check('connection without a client certificate is refused', !noCert.ok);

  const rogue = await request({ ca: ca.cert, key: rogueClient.private, cert: rogueClient.cert });
  check('client certificate from a different CA is refused', !rogue.ok);

  const untrusted = await request({ ca: rogueCa.cert, key: client.private, cert: client.cert });
  check('client refuses a server it cannot verify (spoofed endpoint)', !untrusted.ok);

  await new Promise((resolve) => srv.close(resolve));
});

// ---------------------------------------------------------------------------
await section('6. Better Auth (SQLite + migrations + two-factor enforcement at sign-in)', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { betterAuth } = await import('better-auth');
  const { twoFactor } = await import('better-auth/plugins');
  const { getMigrations } = await import('better-auth/db/migration');

  const db = new Database(path.join(tmpDir, 'auth-check.db'));
  try {
    const auth = betterAuth({
      appName: 'VaultPay',
      baseURL: 'http://localhost:3000',
      secret: crypto.randomBytes(32).toString('hex'),
      database: db,
      emailAndPassword: { enabled: true },
      plugins: [twoFactor({ issuer: 'VaultPay' })],
    });

    const { toBeCreated, runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const tables = toBeCreated.map((t) => t.table);
    check(`migrations created auth tables (${tables.join(', ')})`, tables.includes('user') && tables.includes('session'));
    check('two-factor table created', tables.includes('twoFactor'));

    const email = 'smoke.user@example.test';
    const password = 'Smoke-Test-Passw0rd!';
    await auth.api.signUpEmail({ body: { email, password, name: 'Smoke User' } });

    const cookieHeader = (headers) => headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    const first = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const sessionHeaders = new Headers({ cookie: cookieHeader(first.headers) });
    check('password sign-in works before MFA is enabled', Boolean(first.response?.token));

    const enabled = await auth.api.enableTwoFactor({ body: { password }, headers: sessionHeaders });
    check('enableTwoFactor returns a TOTP URI', typeof enabled?.totpURI === 'string' && enabled.totpURI.startsWith('otpauth://'));

    const secret = new URL(enabled.totpURI).searchParams.get('secret');
    await auth.api.verifyTOTP({ body: { code: totp(secret) }, headers: sessionHeaders });
    const row = db.prepare('SELECT twoFactorEnabled FROM user WHERE email = ?').get(email);
    check('two-factor is enabled after verifying a TOTP code', row?.twoFactorEnabled === 1, JSON.stringify(row));

    // The key MFA check: once 2FA is on, a correct password alone must NOT produce a session.
    const second = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    check('password alone now returns a two-factor challenge, not a session',
      second.response && 'twoFactorRedirect' in second.response && !second.response.token,
      JSON.stringify(second.response));

    const challengeHeaders = new Headers({ cookie: cookieHeader(second.headers) });
    let wrongRejected = false;
    try {
      await auth.api.verifyTOTP({ body: { code: '000000' }, headers: challengeHeaders });
    } catch { wrongRejected = true; }
    check('wrong TOTP code is rejected', wrongRejected);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Minimal RFC 6238 TOTP (SHA-1, 6 digits, 30 s) – used ONLY by this test to act as the
// authenticator app. The application itself relies on Better Auth's implementation.
function totp(base32Secret, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32Secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

// Cleanup must never hide the results. On Windows a database left open by a failed
// section can make the delete fail (EBUSY); retry briefly, then just report the leftover folder.
try {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (err) {
  console.log(`\n  NOTE  could not delete temporary folder ${tmpDir} (${err?.code ?? err?.message ?? err}); safe to delete by hand`);
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

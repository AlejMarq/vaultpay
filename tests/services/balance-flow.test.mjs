import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { SignJWT } from 'jose';

import { fetchCustomerBalance } from '../../lib/server/balance.js';
import { AccessDenied } from '../../lib/server/dal.js';
import { certificateThumbprint, createReplayCache, signServiceToken, verifyServiceToken } from '../../lib/services/service-token.js';
import { DEMO_CUSTOMERS, DEMO_OPS_USERS } from '../../scripts/setup/demo-data.mjs';
import { freshInstall } from '../helpers/setup.mjs';
import { servicesHarness } from '../helpers/services.mjs';

const [alice, bob, carol] = DEMO_CUSTOMERS;
const [support] = DEMO_OPS_USERS;

const x509 = (pem) => new crypto.X509Certificate(pem);
const peerOf = (pem) => ({ subject: { CN: x509(pem).subject.replace(/^CN=/, '') }, raw: x509(pem).raw });

// A token signed with Identity's real key but with claims chosen by the test.
async function forge(s, overrides = {}, { header = {}, key = s.signingKey, lifetime = 30, iatOffset = 0 } = {}) {
  const iat = Math.floor(Date.now() / 1000) + iatOffset;
  const claims = {
    scope: 'corebanking.balance:read', account_ref: 'MCB-1001', wallet_id: 'wal_demo_alice',
    cnf: { 'x5t#S256': certificateThumbprint(x509(s.webCredentials.cert).raw) }, ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'vaultpay-service+jwt', kid: s.keyId, ...header })
    .setIssuer(overrides.iss ?? 'vaultpay-identity').setAudience(overrides.aud ?? 'vaultpay-cbi').setSubject(overrides.sub ?? 'vaultpay-web')
    .setIssuedAt(iat).setExpirationTime(iat + lifetime).setJti(crypto.randomBytes(16).toString('base64url'))
    .sign(key);
}
const cbiBalance = (s, token, creds) => s.call(s.cbiPort, { path: '/v1/balance', creds, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
const identityToken = (s, sessionToken, creds) => s.call(s.identityPort, { path: '/v1/service-tokens/customer-balance', method: 'POST', creds, body: { sessionToken } });

// ---------------------------------------------------------------------------
// End-to-end: Next.js → Identity → CBI → mock Core Banking
// ---------------------------------------------------------------------------
test('an MFA-verified customer gets their own balance through Identity and CBI', async (t) => {
  const s = await servicesHarness(t);
  for (const [user, cents] of [[alice, 50_000], [bob, 25_000], [carol, 10_000]]) {
    const { browser, viewer } = await s.verifiedLogin(user);
    const balance = await fetchCustomerBalance(viewer, s.balanceDeps(browser));
    assert.deepEqual({ ...balance, asOf: typeof balance.asOf }, { available: true, balanceCents: cents, currency: 'USD', status: 'active', asOf: 'string' }, user.email);
    assert.ok(!JSON.stringify(balance).includes('MCB-'), 'no bank account reference reaches the page');
  }
});

test('Carol cannot obtain Alice\'s balance', async (t) => {
  const s = await servicesHarness(t);
  const a = await s.verifiedLogin(alice);
  const c = await s.verifiedLogin(carol);
  // Carol's own session can only ever yield a token for Carol's account.
  const carolToken = await identityToken(s, s.sessionTokenOf(c.browser));
  const payload = JSON.parse(Buffer.from(carolToken.json.token.split('.')[1], 'base64url'));
  assert.equal(payload.account_ref, 'MCB-1003');
  // Asking Identity for a specific account is not possible – the request has one field.
  for (const body of [{ sessionToken: s.sessionTokenOf(c.browser), account_ref: 'MCB-1001' }, { sessionToken: s.sessionTokenOf(c.browser), scope: 'x' }, { accountRef: 'MCB-1001' }]) {
    const r = await s.call(s.identityPort, { path: '/v1/service-tokens/customer-balance', method: 'POST', body });
    assert.deepEqual([r.status, r.json], [400, { error: 'invalid_request' }], JSON.stringify(body));
  }
  // Editing the token's account breaks the signature.
  const [h, , sig] = carolToken.json.token.split('.');
  const edited = `${h}.${Buffer.from(JSON.stringify({ ...payload, account_ref: 'MCB-1001', wallet_id: 'wal_demo_alice' })).toString('base64url')}.${sig}`;
  assert.equal((await cbiBalance(s, edited)).status, 401);
  // A mixed-up session (Carol's viewer, Alice's session) is refused by the wallet check.
  const mixed = await fetchCustomerBalance(c.viewer, s.balanceDeps(a.browser));
  assert.deepEqual(mixed, { available: false, reason: 'wallet_mismatch' });
});

test('support users and incomplete-MFA sessions get no customer balance', async (t) => {
  const s = await servicesHarness(t);
  const sp = await s.verifiedLogin(support);
  await assert.rejects(fetchCustomerBalance(sp.viewer, s.balanceDeps(sp.browser)), (err) => err instanceof AccessDenied && err.reason === 'wrong-role');
  assert.equal((await identityToken(s, s.sessionTokenOf(sp.browser))).status, 403, 'Identity refuses a non-customer session');

  const { browser } = await s.passwordLogin(bob);
  const pwOnly = await s.viewerOf(browser);
  await assert.rejects(fetchCustomerBalance(pwOnly, s.balanceDeps(browser)), (err) => err instanceof AccessDenied && err.reason === 'mfa-required');
  assert.equal((await identityToken(s, s.sessionTokenOf(browser))).status, 403, 'Identity refuses a password-only session');
});

test('Identity refuses expired or unknown sessions, suspended customers and frozen wallets', async (t) => {
  const s = await servicesHarness(t);
  const { browser } = await s.verifiedLogin(alice);
  const token = s.sessionTokenOf(browser);
  assert.equal((await identityToken(s, token)).status, 200);
  assert.equal((await identityToken(s, 'x'.repeat(32))).status, 403);
  assert.equal((await identityToken(s, 'bad token!')).status, 400);

  s.identityDb.prepare("UPDATE wallet SET status = 'frozen' WHERE wallet_id = 'wal_demo_alice'").run();
  assert.equal((await identityToken(s, token)).status, 403);
  s.identityDb.prepare("UPDATE wallet SET status = 'active' WHERE wallet_id = 'wal_demo_alice'").run();
  s.identityDb.prepare("UPDATE customer SET status = 'suspended' WHERE customer_id = 'cus_demo_alice'").run();
  assert.equal((await identityToken(s, token)).status, 403);
  s.identityDb.prepare("UPDATE customer SET status = 'active' WHERE customer_id = 'cus_demo_alice'").run();
  s.identityDb.prepare('UPDATE session SET expiresAt = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await identityToken(s, token)).status, 403);
});

// ---------------------------------------------------------------------------
// Tokens at CBI
// ---------------------------------------------------------------------------
test('CBI refuses missing, expired, wrong-audience, wrong-scope, forged and over-long tokens', async (t) => {
  const s = await servicesHarness(t);
  const other = await freshInstall(t);
  const otherKey = crypto.createPrivateKey({ key: Buffer.from(fs.readFileSync(path.join(other.dataDir, 'secrets', 'identity.env'), 'utf8').match(/^SERVICE_TOKEN_SIGNING_KEY=(.*)$/m)[1], 'base64url'), format: 'der', type: 'pkcs8' });

  assert.equal((await cbiBalance(s, await forge(s))).status, 200, 'baseline: a correct token works');
  const cases = [
    ['missing', undefined, 401],
    ['empty', '', 401],
    ['garbage', 'not.a.token', 401],
    ['expired', await forge(s, {}, { iatOffset: -120, lifetime: 30 }), 401],
    ['wrong audience', await forge(s, { aud: 'vaultpay-settlement' }), 401],
    ['wrong issuer', await forge(s, { iss: 'someone-else' }), 401],
    ['wrong type', await forge(s, {}, { header: { typ: 'JWT' } }), 401],
    ['unknown key id', await forge(s, {}, { header: { kid: 'st-0000000000000000' } }), 401],
    ['signed by another installation', await forge(s, {}, { key: otherKey }), 401],
    ['lifetime over 60 s', await forge(s, {}, { lifetime: 3600 }), 401],
    ['wrong scope', await forge(s, { scope: 'corebanking.settlement:submit' }), 403],
    ['no account', await forge(s, { account_ref: undefined }), 401],
    ['malformed account', await forge(s, { account_ref: '../etc' }), 403],
  ];
  for (const [label, token, status] of cases) {
    const r = await cbiBalance(s, token);
    assert.equal(r.status, status, label);
    assert.ok(['{"error":"unauthorized"}', '{"error":"forbidden"}'].includes(r.text), `${label}: generic body`);
  }
});

test('CBI refuses a replayed token', async (t) => {
  const s = await servicesHarness(t);
  const { browser } = await s.verifiedLogin(alice);
  const { json } = await identityToken(s, s.sessionTokenOf(browser));
  assert.equal((await cbiBalance(s, json.token)).status, 200);
  assert.equal((await cbiBalance(s, json.token)).status, 401, 'second use');
});

test('caller identity and certificate binding are enforced', async (t) => {
  const s = await servicesHarness(t);
  const { browser } = await s.verifiedLogin(alice);
  const fresh = async () => (await identityToken(s, s.sessionTokenOf(browser))).json.token;

  // Only Next.js (CN=vaultpay-web) may call Identity and CBI.
  for (const name of ['recon', 'settlement', 'cbi']) {
    assert.equal((await identityToken(s, s.sessionTokenOf(browser), s.certOf(name))).status, 403, `Identity refuses ${name}`);
    assert.equal((await cbiBalance(s, await fresh(), s.certOf(name))).status, 403, `CBI refuses ${name}`);
  }
  // No client certificate at all: refused in the handshake.
  assert.equal((await identityToken(s, 'x'.repeat(32), { ca: s.webCredentials.ca })).ok, false);
  assert.equal((await cbiBalance(s, await fresh(), { ca: s.webCredentials.ca })).ok, false);
  // A token bound to a different certificate is useless even for the right caller.
  const boundToRecon = await forge(s, { cnf: { 'x5t#S256': certificateThumbprint(x509(s.certOf('recon').cert).raw) } });
  assert.equal((await cbiBalance(s, boundToRecon)).status, 401);
  // A token issued to another subject is refused.
  assert.equal((await cbiBalance(s, await forge(s, { sub: 'vaultpay-recon' }))).status, 401);
});

test('token verification: subject must equal the TLS peer, and the cache refuses reuse', async (t) => {
  const s = await servicesHarness(t);
  const peer = peerOf(s.webCredentials.cert);
  const opts = (overrides = {}) => ({ publicKey: crypto.createPublicKey(s.signingKey), keyId: s.keyId, audience: 'vaultpay-cbi', peerCertificate: peer,
    allowedScopes: { 'vaultpay-web': ['corebanking.balance:read'] }, replayCache: createReplayCache(), ...overrides });
  const { token } = await signServiceToken({ privateKey: s.signingKey, keyId: s.keyId, audience: 'vaultpay-cbi', subject: 'vaultpay-web', scope: 'corebanking.balance:read', clientCertDer: peer.raw, claims: { account_ref: 'MCB-1001', wallet_id: 'wal_demo_alice' } });
  const cache = createReplayCache();
  await verifyServiceToken(token, opts({ replayCache: cache }));
  await assert.rejects(verifyServiceToken(token, opts({ replayCache: cache })), /replayed/);
  await assert.rejects(verifyServiceToken(token, opts({ peerCertificate: peerOf(s.certOf('recon').cert) })), /subject does not match/);
  await assert.rejects(verifyServiceToken(token, opts({ peerCertificate: { ...peer, raw: x509(s.certOf('recon').cert).raw } })), /not bound/);
});

// ---------------------------------------------------------------------------
// Dependencies down: fail closed, generic
// ---------------------------------------------------------------------------
test('mock bank down → CBI 503 → "unavailable"; CBI or Identity down → "unavailable"', async (t) => {
  const s = await servicesHarness(t);
  const { browser, viewer } = await s.verifiedLogin(alice);
  assert.equal((await fetchCustomerBalance(viewer, s.balanceDeps(browser))).available, true);

  await s.close(s.bank);
  const bankDown = await fetchCustomerBalance(viewer, s.balanceDeps(browser));
  assert.deepEqual(bankDown, { available: false, reason: 'cbi_503' });
  const direct = await cbiBalance(s, (await identityToken(s, s.sessionTokenOf(browser))).json.token);
  assert.deepEqual([direct.status, direct.json], [503, { error: 'unavailable' }]);

  await s.close(s.cbi);
  assert.deepEqual(await fetchCustomerBalance(viewer, s.balanceDeps(browser)), { available: false, reason: 'unavailable' });
  await s.close(s.identity);
  assert.deepEqual(await fetchCustomerBalance(viewer, s.balanceDeps(browser)), { available: false, reason: 'unavailable' });
});

test('an oversized request body is cut off without bringing a service down', async (t) => {
  const s = await servicesHarness(t);
  const big = await s.call(s.identityPort, { path: '/v1/service-tokens/customer-balance', method: 'POST', body: JSON.stringify({ sessionToken: 'x'.repeat(20_000) }) });
  assert.ok(!big.ok || big.status === 400, `got ${big.status}`);
  const after = await s.call(s.identityPort, { path: '/v1/service-tokens/customer-balance', method: 'POST', body: { sessionToken: 'y'.repeat(32) } });
  assert.equal(after.status, 403, 'Identity still serving');
});

test('an account mapping the bank does not know → generic upstream error, never another account', async (t) => {
  const s = await servicesHarness(t);
  const r = await cbiBalance(s, await forge(s, { account_ref: 'MCB-9999' }));
  assert.deepEqual([r.status, r.json], [502, { error: 'upstream_error' }]);
});

test('no token, key, account reference or internal error in anything Next.js receives for the page', async (t) => {
  const s = await servicesHarness(t);
  const { browser, viewer } = await s.verifiedLogin(alice);
  const ok = await fetchCustomerBalance(viewer, s.balanceDeps(browser));
  await s.close(s.bank);
  const down = await fetchCustomerBalance(viewer, s.balanceDeps(browser));
  const text = JSON.stringify([ok, down]);
  for (const f of ['eyJ', 'MCB-', 'PRIVATE KEY', 'CERTIFICATE', 'vaultpay-identity', 'corebanking', s.sessionTokenOf(browser), 'stack']) {
    assert.ok(!text.includes(f), `contains ${f}`);
  }
});

test('the Next.js code never reads the signing key, CBI/bank credentials or the mock bank', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.(js|mjs)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        if (/lib\/cbi|services\/(identity|cbi|mock-core-banking)|identity\.env|cbi\.env|mock-core-banking\.env|loadProcessEnv\(['"](identity|cbi|mock-core-banking)['"]|privateKeyFrom|signServiceToken|openMockCoreBankingDb/.test(src)) offenders.push(p);
      }
    }
  };
  scan('app');
  for (const f of fs.readdirSync(path.join('lib', 'server')).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join('lib', 'server', f), 'utf8');
    if (/lib\/cbi|services\/(identity|cbi|mock-core-banking)|identity\.env|cbi\.env|loadProcessEnv\(['"](identity|cbi|mock-core-banking)['"]|privateKeyFrom|signServiceToken|openMockCoreBankingDb/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

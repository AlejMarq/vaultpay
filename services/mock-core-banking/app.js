// Mock Core Banking HTTPS service (Step 4A) – stands in for the partner Core Banking
// System that VaultPay does not control. Only Core Banking Integration (CBI) may call it.
//
// Every request must pass, in this order:
//   1. mutual TLS: a client certificate signed by this installation's development CA
//      (rejectUnauthorized: true – unauthenticated clients never reach HTTP)
//   2. caller identity: the certificate subject must be CN=vaultpay-cbi (Settlement and
//      Reconciliation have certificates from the same CA but must not reach the bank)
//   3. the partner credential CBI holds (Authorization: Bearer <MOCK_CORE_BANKING_API_KEY>)
//   4. a strictly validated request
// Errors are generic JSON ({"error": "<code>"}): no stack traces, paths, SQL or input echo.
//
// Endpoints:
//   GET  /v1/accounts/{accountRef}/balance
//   POST /v1/postings  {idempotencyKey, debitAccount, creditAccount, amountCents, currency, reference}
//        (Step 7) In ONE database transaction: an existing posting with this idempotency
//        key is returned as it was (or refused if the payload differs – 409); otherwise both
//        accounts must exist and be active and the debit must stay ≥ 0 (the bank's own
//        funds check), then debit, credit and the posting row are written together.
//        200 {status:"posted", postingRef, replayed} | 422 {error:"insufficient_funds" |
//        "account_inactive" | "account_not_found"} – definitive, nothing moved | 409.
//   GET  /v1/postings/{idempotencyKey}   (Step 8, read-only) the posting recorded for that
//        key: 200 {postingRef, idempotencyKey, debitAccount, creditAccount, amountCents,
//        currency, reference} | 404 {error:"not_found"}
//   `postResponseDelayMs` (tests and demo only): answer a posting that late AFTER it was
//   committed – a lost/timed-out response with the money already moved.

import crypto from 'node:crypto';
import https from 'node:https';

import { z } from 'zod';

import { readJsonBody } from '../common/https-service.js';

export const ALLOWED_CLIENTS = Object.freeze(['vaultpay-cbi']);
export const ACCOUNT_REF_PATTERN = /^MCB-[0-9]{4,10}$/;
const BALANCE_PATH = /^\/v1\/accounts\/([^/]*)\/balance$/;
const POSTING_PATH = /^\/v1\/postings\/(stlk_[0-9a-f]{24})$/;
const PostingRequest = z.object({
  idempotencyKey: z.string().regex(/^stlk_[0-9a-f]{24}$/),
  debitAccount: z.string().regex(ACCOUNT_REF_PATTERN),
  creditAccount: z.string().regex(ACCOUNT_REF_PATTERN),
  amountCents: z.number().int().min(1).max(1_000_000),
  currency: z.literal('USD'),
  reference: z.string().regex(/^trf_[A-Za-z0-9_]{1,60}$/),
}).strict();

class PostingRefused extends Error {
  constructor(code, status = 422) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const MAX_URL_LENGTH = 256;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function send(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(text);
}

/**
 * Creates the server (not listening). `db` is the bank's own connection to the mock Core
 * Banking database (writable for postings); `apiKey` is the credential CBI must present.
 */
export function createMockCoreBankingServer({ tls, apiKey, db, allowedClients = ALLOWED_CLIENTS, now = () => Date.now(), postResponseDelayMs = 0, log = () => {} }) {
  if (!apiKey || apiKey.length < 32) throw new Error('mock Core Banking: API key missing or too short');
  const balanceOf = db.prepare('SELECT account_ref, currency, status, balance_cents, updated_at FROM account WHERE account_ref = ?');
  const postingByKey = db.prepare('SELECT posting_ref, debit_account, credit_account, amount_cents, currency, reference FROM posting WHERE idempotency_key = ?');
  const move = db.prepare('UPDATE account SET balance_cents = balance_cents + @delta, updated_at = max(updated_at, @t) WHERE account_ref = @ref');
  const insertPosting = db.prepare(`INSERT INTO posting (posting_ref, idempotency_key, debit_account, credit_account, amount_cents, currency, reference, created_at)
    VALUES (@ref, @key, @debit, @credit, @amount, @currency, @reference, @t)`);

  const post = db.transaction((p) => {
    const existing = postingByKey.get(p.idempotencyKey);
    if (existing) {
      const same = existing.debit_account === p.debitAccount && existing.credit_account === p.creditAccount
        && existing.amount_cents === p.amountCents && existing.currency === p.currency && existing.reference === p.reference;
      if (!same) throw new PostingRefused('idempotency_conflict', 409);
      return { postingRef: existing.posting_ref, replayed: true };
    }
    if (p.debitAccount === p.creditAccount) throw new PostingRefused('invalid_request', 400);
    const debit = balanceOf.get(p.debitAccount);
    const credit = balanceOf.get(p.creditAccount);
    if (!debit || !credit) throw new PostingRefused('account_not_found');
    if (debit.status !== 'active' || credit.status !== 'active') throw new PostingRefused('account_inactive');
    if (debit.balance_cents < p.amountCents) throw new PostingRefused('insufficient_funds');
    const t = now();
    const ref = `MCBP-${crypto.randomBytes(10).toString('hex')}`;
    move.run({ ref: p.debitAccount, delta: -p.amountCents, t });
    move.run({ ref: p.creditAccount, delta: p.amountCents, t });
    insertPosting.run({ ref, key: p.idempotencyKey, debit: p.debitAccount, credit: p.creditAccount, amount: p.amountCents, currency: p.currency, reference: p.reference, t });
    return { postingRef: ref, replayed: false };
  });

  async function posting(req, res) {
    const parsed = PostingRequest.safeParse(await readJsonBody(req));
    if (!parsed.success) return send(res, 400, { error: 'invalid_request' });
    let result;
    try {
      result = post.immediate(parsed.data);
    } catch (err) {
      if (err instanceof PostingRefused) {
        log(`posting refused: ${err.code}`);
        return send(res, err.status, { error: err.code });
      }
      // The schema's own guards (balance ≥ 0, active accounts) are a definitive refusal too.
      if (err?.code === 'SQLITE_CONSTRAINT_CHECK') return send(res, 422, { error: 'insufficient_funds' });
      if (err?.code === 'SQLITE_CONSTRAINT_TRIGGER') return send(res, 422, { error: 'account_inactive' });
      throw err;
    }
    log(`posting ${result.replayed ? 'replayed' : 'committed'} ${result.postingRef}`);
    const delay = typeof postResponseDelayMs === 'function' ? postResponseDelayMs() : postResponseDelayMs;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return send(res, 200, { status: 'posted', postingRef: result.postingRef, replayed: result.replayed });
  }

  const server = https.createServer({
    key: tls.key,
    cert: tls.cert,
    ca: tls.ca,
    requestCert: true,
    rejectUnauthorized: true, // never disabled: clients without a CA-signed certificate fail the handshake
    minVersion: 'TLSv1.2',
  }, async (req, res) => {
    try {
      // (1) is enforced by the TLS layer; double-check rather than assume.
      if (!req.socket.authorized) return send(res, 401, { error: 'unauthorized' });
      const peer = req.socket.getPeerCertificate();
      if (!allowedClients.includes(peer?.subject?.CN)) {
        log(`refused client CN=${peer?.subject?.CN ?? '?'}`);
        return send(res, 403, { error: 'forbidden' });
      }
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), apiKey)) return send(res, 401, { error: 'unauthorized' });

      const url = req.url ?? '';
      if (url === '/v1/postings') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        return await posting(req, res);
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      const byKey = POSTING_PATH.exec(url);
      if (byKey) {
        const p = postingByKey.get(byKey[1]);
        if (!p) return send(res, 404, { error: 'not_found' });
        return send(res, 200, {
          postingRef: p.posting_ref, idempotencyKey: byKey[1], debitAccount: p.debit_account, creditAccount: p.credit_account,
          amountCents: p.amount_cents, currency: p.currency, reference: p.reference,
        });
      }
      if (url.length > MAX_URL_LENGTH || url.includes('?') || url.includes('#')) return send(res, 400, { error: 'invalid_request' });
      const match = BALANCE_PATH.exec(url);
      if (!match) return send(res, 404, { error: 'not_found' });
      const accountRef = match[1];
      if (!ACCOUNT_REF_PATTERN.test(accountRef)) return send(res, 400, { error: 'invalid_account' });

      const row = balanceOf.get(accountRef);
      if (!row) return send(res, 404, { error: 'not_found' });
      return send(res, 200, {
        accountRef: row.account_ref,
        currency: row.currency,
        balanceCents: row.balance_cents,
        status: row.status,
        asOf: new Date(row.updated_at).toISOString(),
      });
    } catch (err) {
      log(`internal error: ${err.code ?? err.name}`);
      if (!res.headersSent) return send(res, 500, { error: 'internal_error' });
      return res.destroy();
    }
  });

  // Slow or idle clients cannot hold connections open.
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 50;
  return server;
}

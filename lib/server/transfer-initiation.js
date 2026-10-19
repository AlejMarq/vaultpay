// Customer transfer initiation (Step 5): review, then confirm.
//
// Nothing from the browser is trusted for who sends, from which wallet, or how much money
// there is. The sender is the session's viewer; eligibility (active customer, approved KYC,
// an active wallet they own) is read from the identity database again on each step and
// once more immediately before the write; the balance comes from Core Banking through
// Identity and CBI. The browser only says: recipient email, amount, which intended
// transfer this is (idempotency key) and the source wallet it confirmed – which must equal
// the one the server resolves.
//
// Results are plain objects for useActionState; error codes are fixed strings and never
// reveal internal errors, whether an email belongs to someone, or banking details.
//
// Plain module (no next/* imports) so tests can drive it directly.

import crypto from 'node:crypto';

import { AccessDenied } from './dal.js';
import { assertVerifiedCustomer } from './eligibility.js';
import { CURRENCY, MAX_TRANSFER_CENTS, MIN_TRANSFER_CENTS, parseUsdToCents } from './money.js';
import { normalizeEmail } from './rate-limit.js';
import { IDEMPOTENCY_KEY, TransferRejected } from './transfer-orchestrator.js';

export const TRANSFER_ERRORS = Object.freeze({
  invalidAmount: 'invalid_amount',
  amountOutOfRange: 'amount_out_of_range',
  invalidRecipient: 'invalid_recipient', // unknown, inactive or not a customer – one answer for all
  selfTransfer: 'self_transfer',
  sourceWalletChanged: 'source_wallet_changed',
  invalidRequest: 'invalid_request',
  idempotencyConflict: 'idempotency_conflict',
  insufficientFunds: 'insufficient_funds',
  bankingUnavailable: 'banking_unavailable',
  unavailable: 'unavailable',
});
const E = TRANSFER_ERRORS;

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const centsToText = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

const editState = (input, error) => Object.freeze({
  step: 'edit',
  values: Object.freeze({ recipient: text(input?.recipientEmail, 254), amount: text(input?.amount, 32) }),
  ...(error ? { error } : {}),
});

const confirmState = (review, error) => Object.freeze({ step: 'confirm', review: Object.freeze(review), ...(error ? { error } : {}) });

// The source wallet: the active wallet the eligibility check found. It must also be the
// wallet the balance flow uses (Identity and the DAL take the customer's first wallet), or
// the balance would belong to another wallet – so a mismatch fails closed.
function sourceWallet(viewer, eligibility) {
  return eligibility.walletId && eligibility.walletId === viewer.customer.wallet?.walletId ? eligibility.walletId : null;
}

// Amount and recipient format, checked identically on review and confirm.
function parseForm(viewer, input) {
  const amountCents = parseUsdToCents(input?.amount);
  if (amountCents === null) return { error: E.invalidAmount };
  if (amountCents < MIN_TRANSFER_CENTS || amountCents > MAX_TRANSFER_CENTS) return { error: E.amountOutOfRange };
  const recipient = normalizeEmail(input?.recipientEmail);
  if (!recipient) return { error: E.invalidRecipient };
  if (recipient === normalizeEmail(viewer.email)) return { error: E.selfTransfer };
  return { amountCents, recipient };
}

/**
 * Step 1: validate the form and show what will be sent. Does not look the recipient up,
 * so reviewing reveals nothing about which emails have accounts. Each review starts a new
 * intended transfer with a fresh idempotency key.
 * Throws AccessDenied if the viewer may not send money.
 */
export function reviewTransfer(viewer, input, { identityDb, newKey = () => crypto.randomUUID() }) {
  const { eligibility } = assertVerifiedCustomer(viewer, identityDb);
  const parsed = parseForm(viewer, input);
  if (parsed.error) return editState(input, parsed.error);
  const walletId = sourceWallet(viewer, eligibility);
  if (!walletId) return editState(input, E.sourceWalletChanged);
  return confirmState({
    recipient: parsed.recipient,
    amount: centsToText(parsed.amountCents),
    amountCents: parsed.amountCents,
    currency: CURRENCY,
    sourceWalletId: walletId,
    idempotencyKey: newKey(),
  });
}

// The recipient's active wallet, by email. Only active customers with an active wallet
// can receive; ops users and unknown emails are not distinguishable from each other.
function recipientWallet(identityDb, email) {
  return identityDb.prepare(`
    SELECT c.customer_id, w.wallet_id
    FROM "user" u
    JOIN customer c ON c.auth_user_id = u.id AND c.status = 'active'
    JOIN wallet w ON w.customer_id = c.customer_id AND w.status = 'active'
    WHERE u.email = ?
    ORDER BY w.created_at
    LIMIT 1`).get(email) ?? null;
}

const done = ({ transfer, replayed }, recipient) => Object.freeze({
  step: 'done',
  replayed,
  transfer: Object.freeze({
    transferId: transfer.transferId,
    recipient,
    amountCents: transfer.amountCents,
    currency: transfer.currency,
    status: transfer.status,
    createdAt: new Date(transfer.createdAt).toISOString(),
  }),
});

/**
 * Step 2: create the transfer (status pending_risk – never completed here).
 * deps: { identityDb (read-only), writer (transfer-orchestrator), fetchBalance: () => balance }.
 * Throws AccessDenied if the viewer may not send money (checked at the start and again
 * immediately before writing).
 */
export async function initiateTransfer(viewer, input, { identityDb, writer, fetchBalance, log = console.error }) {
  const { eligibility } = assertVerifiedCustomer(viewer, identityDb);

  const idempotencyKey = text(input?.idempotencyKey, 200);
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return editState(input, E.invalidRequest);
  const parsed = parseForm(viewer, input);
  if (parsed.error) return editState(input, parsed.error);
  const senderWalletId = sourceWallet(viewer, eligibility);
  if (!senderWalletId || input.sourceWalletId !== senderWalletId) return editState(input, E.sourceWalletChanged);

  const review = { recipient: parsed.recipient, amount: centsToText(parsed.amountCents), amountCents: parsed.amountCents, currency: CURRENCY, sourceWalletId: senderWalletId, idempotencyKey };
  const fail = (error, err) => {
    if (err) log(`[transfer] not created: ${error} (${err.code ?? err.name ?? 'error'})`);
    // Retryable with the same key (banking/database unavailable) → stay on the confirmation.
    return [E.idempotencyConflict, E.insufficientFunds, E.invalidRecipient, E.sourceWalletChanged].includes(error)
      ? editState(input, error)
      : confirmState(review, error);
  };

  const recipientRequest = () => {
    const payee = recipientWallet(identityDb, parsed.recipient);
    if (!payee || payee.customer_id === viewer.customer.customerId || payee.wallet_id === senderWalletId) return null;
    return payee;
  };

  try {
    const payee = recipientRequest();
    if (!payee) return fail(E.invalidRecipient);
    const request = {
      customerId: viewer.customer.customerId, senderWalletId, recipientWalletId: payee.wallet_id,
      amountCents: parsed.amountCents, currency: CURRENCY, idempotencyKey,
    };

    // A retry of a transfer that was already recorded is answered from the database, even
    // while banking is unavailable – and never creates a second transfer.
    const existing = writer.find({ senderWalletId, idempotencyKey });
    // (create() returns the stored row, or refuses a different payload, before any funds check.)
    if (existing) return done(writer.create({ ...request, balanceCents: 0 }), parsed.recipient);

    // Preliminary funds check (fail closed): the authorized balance flow for this customer.
    const balance = await fetchBalance();
    if (!balance?.available || balance.status !== 'active' || balance.currency !== CURRENCY || !Number.isSafeInteger(balance.balanceCents)) {
      return fail(E.bankingUnavailable);
    }

    // Immediately before writing (synchronously, no await in between): eligibility, the
    // source wallet and the recipient again – a freeze, suspension or KYC change made
    // while the balance was being fetched still applies.
    const recheck = assertVerifiedCustomer(viewer, identityDb);
    if (sourceWallet(viewer, recheck.eligibility) !== senderWalletId) return fail(E.sourceWalletChanged);
    const payeeNow = recipientRequest();
    if (!payeeNow || payeeNow.wallet_id !== payee.wallet_id) return fail(E.invalidRecipient);

    return done(writer.create({ ...request, balanceCents: balance.balanceCents }), parsed.recipient);
  } catch (err) {
    if (err instanceof TransferRejected) {
      return fail(err.code === 'idempotency_conflict' ? E.idempotencyConflict : err.code === 'insufficient_funds' ? E.insufficientFunds : E.invalidRequest);
    }
    if (err instanceof AccessDenied) throw err;
    return fail(E.unavailable, err);
  }
}
